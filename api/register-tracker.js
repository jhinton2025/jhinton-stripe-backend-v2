function normalizeCarrier(carrier = '') {
  const c = String(carrier).trim().toLowerCase();
  if (c.includes('usps') || c.includes('postal')) return 'USPS';
  if (c.includes('ups')) return 'UPS';
  if (c.includes('fedex') || c.includes('fed ex')) return 'FedEx';
  if (c.includes('dhl')) return 'DHLExpress';
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const expected = process.env.ORDER_SYNC_SECRET || '';
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const apiKey = process.env.EASYPOST_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'EASYPOST_API_KEY is not configured.' });

  try {
    const { trackingNumber = '', carrier = '', orderNumber = '' } = req.body || {};
    const trackingCode = String(trackingNumber).trim();
    if (!trackingCode) return res.status(400).json({ ok: false, error: 'Tracking number is required.' });

    const payload = { tracker: { tracking_code: trackingCode } };
    const normalized = normalizeCarrier(carrier);
    if (normalized) payload.tracker.carrier = normalized;

    const token = Buffer.from(`${apiKey}:`).toString('base64');
    const response = await fetch('https://api.easypost.com/v2/trackers', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('EasyPost tracker create failed', { orderNumber, status: response.status, error: data?.error || data });
      return res.status(response.status).json({
        ok: false,
        error: data?.error?.message || data?.error || `EasyPost returned HTTP ${response.status}`
      });
    }

    console.log('J.HINTON EasyPost tracker registered', {
      orderNumber,
      trackerId: data?.id,
      carrier: data?.carrier,
      status: data?.status
    });

    return res.status(200).json({
      ok: true,
      trackerId: data?.id || '',
      carrier: data?.carrier || normalized || carrier,
      status: data?.status || ''
    });
  } catch (error) {
    console.error('J.HINTON register tracker error:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'Unable to register tracker.' });
  }
}
