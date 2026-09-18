import { GoogleAuth } from 'google-auth-library';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const catalog = require('../catalog.json');

// Simple in-memory rate limiting per serverless container instance (5 req / 10 min)
const ipRateLimit = new Map();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 5;

// Allowed image MIME types and 7 MB upload limit
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 7 * 1024 * 1024; // 7MB

function checkRateLimit(ip) {
  const now = Date.now();
  const record = ipRateLimit.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  record.count += 1;
  ipRateLimit.set(ip, record);
  return record.count <= MAX_REQUESTS;
}

function handleCors(req, res) {
  const allowedOrigin = process.env.CORS_ORIGIN || 'https://j-hinton.com';
  const origin = req.headers.origin;
  if (origin === allowedOrigin || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || allowedOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb' // Accommodates up to 7MB raw base64 payload
    }
  }
};

export default async function handler(req, res) {
  handleCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please try again in a few minutes.' });
  }

  try {
    const { productId, userImageBase64, userImageMime } = req.body || {};

    if (!productId || !userImageBase64 || !userImageMime) {
      return res.status(400).json({ error: 'Missing productId, userImageBase64, or userImageMime' });
    }

    if (!ALLOWED_MIME_TYPES.includes(userImageMime)) {
      return res.status(400).json({ error: 'Unsupported format. Please upload JPG, PNG, or WebP.' });
    }

    // Validate size of customer photo
    const cleanUserB64 = userImageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
    const estimatedSize = Math.ceil((cleanUserB64.length * 3) / 4);
    if (estimatedSize > MAX_FILE_SIZE_BYTES) {
      return res.status(400).json({ error: 'File size exceeds the 7MB limit.' });
    }

    // Verify product exists in catalog
    const product = catalog[productId];
    if (!product) {
      return res.status(404).json({ error: 'Product not found in catalog.' });
    }

    // Resolve product image from Hostinger CDN
    const cdnBase = 'https://j-hinton.com';
    const productImagePath = product.vtoImage || product.img;
    const productImgUrl = productImagePath.startsWith('http') ? productImagePath : `${cdnBase}${productImagePath}`;

    const prodImgRes = await fetch(productImgUrl);
    if (!prodImgRes.ok) {
      return res.status(502).json({ error: 'Failed to retrieve garment reference image.', code: 'GARMENT_IMAGE_FETCH_FAILED' });
    }
    const productBuffer = Buffer.from(await prodImgRes.arrayBuffer());
    const productB64 = productBuffer.toString('base64');

    // Authenticate with Google Vertex AI
    const projectId = process.env.GCP_PROJECT_ID || 'stone-arch-508908-c0';
    const region = process.env.GCP_REGION || 'us-central1';

    let credentials;
    if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
      credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
      if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }

    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const client = await auth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    const accessToken = accessTokenResponse.token;

    if (!accessToken) {
      return res.status(500).json({ error: 'Failed to authenticate with Vertex AI.' });
    }

    // Call Vertex AI REST predict endpoint
    const endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/virtual-try-on-001:predict`;

    const payload = {
      instances: [
        {
          personImage: {
            image: {
              bytesBase64Encoded: cleanUserB64
            }
          },
          productImages: [
            {
              image: {
                bytesBase64Encoded: productB64
              }
            }
          ]
        }
      ],
      parameters: {
        sampleCount: 1
      }
    };

    const vertexRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(payload)
    });

    const vertexData = await vertexRes.json();

    if (!vertexRes.ok) {
      // Graceful error message if billing is not yet activated
      if (vertexData.error?.message?.includes('billing')) {
        return res.status(503).json({
          error: 'Virtual Try-On is connected, but Google Cloud billing is not enabled yet.', code: 'BILLING_DISABLED'
        });
      }
      return res.status(vertexRes.status).json({
        error: vertexData.error?.message || 'Vertex AI Virtual Try-On failed.', code: vertexData.error?.status || 'VERTEX_AI_ERROR'
      });
    }

    const prediction = vertexData.predictions?.[0];
    if (!prediction || (!prediction.bytesBase64Encoded && !prediction.image?.bytesBase64Encoded)) {
      return res.status(502).json({ error: 'Model did not return a generated prediction.' });
    }

    const outputB64 = prediction.bytesBase64Encoded || prediction.image.bytesBase64Encoded;
    const outputMime = prediction.mimeType || 'image/png';

    return res.status(200).json({
      success: true,
      resultImage: `data:${outputMime};base64,${outputB64}`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal server error processing try-on.' });
  }
      }
