import Stripe from 'stripe';
import { readFileSync } from 'node:fs';
import { applyCors } from '../cors.js';

const catalog = JSON.parse(
  readFileSync(new URL('../catalog.json', import.meta.url), 'utf8')
);

function normalizeCatalog(rawCatalog) {
  if (Array.isArray(rawCatalog)) return rawCatalog;

  if (rawCatalog && Array.isArray(rawCatalog.products)) {
    return rawCatalog.products;
  }

  if (rawCatalog && typeof rawCatalog === 'object') {
    return Object.entries(rawCatalog)
      .map(([key, value]) => {
        if (!value || typeof value !== 'object') return null;
        return {
          id: value.id || value.slug || key,
          slug: value.slug || key,
          ...value
        };
      })
      .filter(Boolean);
  }

  return [];
}

function clean(value) {
  return String(value ?? '').trim();
}

function normalized(value) {
  return clean(value).toLowerCase();
}

function basenameFromUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  const path = raw.split('?')[0].split('#')[0];
  const name = path.split('/').filter(Boolean).pop() || '';
  return name.replace(/\.html?$/i, '');
}

function unique(values) {
  return [...new Set(values.map(normalized).filter(Boolean))];
}

function requestedKeys(item) {
  return unique([
    item?.id,
    item?.productId,
    item?.product_id,
    item?.slug,
    item?.sku,
    item?.code,
    basenameFromUrl(item?.url),
    item?.title,
    item?.name
  ]);
}

function productKeys(product) {
  return unique([
    product?.id,
    product?.productId,
    product?.product_id,
    product?.slug,
    product?.sku,
    product?.code,
    basenameFromUrl(product?.url),
    product?.title,
    product?.name,
    ...(Array.isArray(product?.variants) ? product.variants.map(v => v.sku) : [])
  ]);
}

function findCatalogProduct(products, requestedItem) {
  const requested = requestedKeys(requestedItem);
  if (!requested.length) return null;

  return products.find((product) => {
    const keys = productKeys(product);
    return requested.some((candidate) => keys.includes(candidate));
  }) || null;
}

function resolveVariant(product, requestedItem) {
  if (!Array.isArray(product?.variants) || !product.variants.length) return null;
  const color = normalized(requestedItem?.color || requestedItem?.selectedColor || requestedItem?.variant?.color);
  const sku = normalized(requestedItem?.sku);
  // Explicit color is authoritative; SKU can identify a variant for older carts.
  return (color && product.variants.find(v => normalized(v.color) === color)) ||
    (sku && product.variants.find(v => normalized(v.sku) === sku)) || null;
}

function getProductName(product) {
  return product?.name || product?.title || 'J.HINTON Product';
}

function getUnitAmount(product) {
  const raw =
    product?.unit_amount ??
    product?.unitAmount ??
    product?.price_cents ??
    product?.priceCents ??
    product?.price;

  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`Missing catalog price for ${getProductName(product)}.`);
  }

  let amount = Number(
    typeof raw === 'string' ? raw.replace(/[$,\s]/g, '') : raw
  );

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid catalog price for ${getProductName(product)}.`);
  }

  const explicitCents =
    product?.unit_amount !== undefined ||
    product?.unitAmount !== undefined ||
    product?.price_cents !== undefined ||
    product?.priceCents !== undefined;

  amount = explicitCents ? Math.round(amount) : Math.round(amount * 100);

  if (amount < 50) {
    throw new Error(`Invalid checkout amount for ${getProductName(product)}.`);
  }

  return amount;
}

function getImage(product) {
  const image =
    product?.img ||
    product?.image ||
    product?.image_url ||
    product?.imageUrl ||
    product?.thumbnail ||
    (Array.isArray(product?.images) ? product.images[0] : null);

  if (!image || typeof image !== 'string') return null;
  if (/^https?:\/\//i.test(image)) return image;

  return `https://j-hinton.com/${image.replace(/^\/+/, '')}`;
}

function makeOrderNumber() {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const random = String(Math.floor(1000 + Math.random() * 9000));
  return `JH-${yy}${mm}${dd}-${random}`;
}

const FLAT_SHIPPING_CENTS = 1195;        // $11.95 standard shipping under $150
const FREE_SHIPPING_MIN_CENTS = 15000;   // complimentary standard shipping at $150+
const WELCOME_SHIPPING_CODE = 'FREESHIP';

// FREESHIP is the Private Access welcome code: valid on a customer's first order only.
// Returns true if this email already has a completed J.HINTON checkout.
async function hasPreviousOrder(stripe, email) {
  const sessions = await stripe.checkout.sessions.list({
    customer_details: { email },
    status: 'complete',
    limit: 1
  });
  return sessions.data.length > 0;
}

// FREESHIP is also limited to Private Access subscribers. The j-hinton.com endpoint
// checks the jh_subscribers list (active) and jh_orders (no paid orders yet).
// Returns true / false, or null if the check could not be completed.
const ELIGIBILITY_URL =
  process.env.FREESHIP_ELIGIBILITY_URL ||
  'https://j-hinton.com/order-api/free-ship-eligibility.php';

async function isPrivateAccessEligible(email) {
  try {
    const response = await fetch(ELIGIBILITY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data && typeof data.eligible === 'boolean' ? data.eligible : null;
  } catch (error) {
    console.error('FREESHIP subscriber lookup failed:', error);
    return null;
  }
}

// ---- The Private Edit: personal welcome codes (e.g. JAY-7KQ4MX) ----
// Issued on j-hinton.com at sign-up: 10% off + complimentary standard shipping,
// first order only, single use, tied to the member's email. j-hinton.com is the
// source of truth; the code is marked used when the paid order syncs (sync.php).
const PRIVATE_EDIT_CODE_PATTERN = /^[A-Z]{2,8}-[A-Z0-9]{6}$/;
const PRIVATE_EDIT_COUPON_PREFIX = 'JH_PRIVATE_EDIT_';
const WELCOME_CODE_URL =
  process.env.WELCOME_CODE_URL ||
  'https://j-hinton.com/order-api/welcome-code.php';

// Returns the site's answer ({ valid, message, percent_off, free_shipping, code })
// or null when the check could not be completed.
async function validatePrivateEditCode(code, email) {
  const secret = process.env.ORDER_SYNC_SECRET;
  if (!secret) {
    console.error('Private Edit code check: ORDER_SYNC_SECRET is not configured.');
    return null;
  }
  try {
    const response = await fetch(WELCOME_CODE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({ action: 'validate', code, email }),
      signal: AbortSignal.timeout(6000)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true || typeof data.valid !== 'boolean') return null;
    return data;
  } catch (error) {
    console.error('Private Edit code check failed:', error);
    return null;
  }
}

// ---- Campaign codes: one shared code anyone can use during a sale window ----
// Any email, any order. Times are US Eastern. Shipping follows normal rules (free on $150+).
const CAMPAIGN_CODES = {
  BLACKFRIDAY25: {
    percentOff: 25,
    label: 'Black Friday',
    starts: '2026-11-23T00:00:00-05:00',
    ends: '2026-11-30T23:59:59-05:00'
  }
};

async function getCampaignCoupon(stripe, code, campaign) {
  const id = `JH_CAMPAIGN_${code}`;
  try {
    return await stripe.coupons.retrieve(id);
  } catch (error) {
    if (error?.code !== 'resource_missing') throw error;
    try {
      return await stripe.coupons.create({
        id,
        percent_off: campaign.percentOff,
        duration: 'once',
        name: `${campaign.label} ${campaign.percentOff}%`
      });
    } catch (createError) {
      if (createError?.code === 'resource_already_exists') return stripe.coupons.retrieve(id);
      throw createError;
    }
  }
}

// One reusable Stripe coupon per percentage, created on first use.
async function getPrivateEditCoupon(stripe, percentOff) {
  const percent = Math.max(1, Math.min(50, Math.round(Number(percentOff) || 10)));
  const id = `${PRIVATE_EDIT_COUPON_PREFIX}${percent}`;
  try {
    return await stripe.coupons.retrieve(id);
  } catch (error) {
    if (error?.code !== 'resource_missing') throw error;
    try {
      return await stripe.coupons.create({
        id,
        percent_off: percent,
        duration: 'once',
        name: `Private Edit Welcome ${percent}%`
      });
    } catch (createError) {
      // Another request may have created it a moment earlier.
      if (createError?.code === 'resource_already_exists') return stripe.coupons.retrieve(id);
      throw createError;
    }
  }
}

function buildShippingOptions(subtotalCents, promoCode = '', freeShippingOverride = false) {
  const normalizedPromo = String(promoCode || '').trim().toUpperCase();
  const freeShippingPromo = normalizedPromo === WELCOME_SHIPPING_CODE || freeShippingOverride;
  const qualifiesForAutomaticFreeShipping = subtotalCents >= FREE_SHIPPING_MIN_CENTS;
  const freeStandard = freeShippingPromo || qualifiesForAutomaticFreeShipping;

  const standard = {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: freeStandard ? 0 : FLAT_SHIPPING_CENTS, currency: 'usd' },
      display_name: freeStandard ? 'Complimentary Standard Shipping' : 'Standard Shipping',
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 3 },
        maximum: { unit: 'business_day', value: 5 }
      }
    }
  };

  const express = {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: 2999, currency: 'usd' },
      display_name: 'Express Shipping',
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 1 },
        maximum: { unit: 'business_day', value: 2 }
      }
    }
  };

  return [standard, express];
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('STRIPE_SECRET_KEY is not configured.');
      return res.status(500).json({
        error: 'Checkout is temporarily unavailable. Stripe is not configured.'
      });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : (req.body || {});

    const requestedItems =
      (Array.isArray(body.items) && body.items) ||
      (Array.isArray(body.cart) && body.cart) ||
      (Array.isArray(body.lineItems) && body.lineItems) ||
      [];

    if (!requestedItems.length) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const products = normalizeCatalog(catalog);
    const lineItems = [];

    for (const requestedItem of requestedItems) {
      const product = findCatalogProduct(products, requestedItem);

      // Security: the server catalog is authoritative for product and price.
      if (!product) {
        const label =
          requestedItem?.title ||
          requestedItem?.name ||
          requestedItem?.id ||
          requestedItem?.sku ||
          'one item';

        return res.status(400).json({
          error: `${label} could not be verified for checkout. Please remove it from your bag and add it again.`
        });
      }

      const quantity = Math.max(
        1,
        Math.min(
          20,
          parseInt(requestedItem?.quantity ?? requestedItem?.qty ?? 1, 10) || 1
        )
      );

      const size = clean(requestedItem?.size);
      const variant = resolveVariant(product, requestedItem);
      const color = clean(variant?.color || requestedItem?.color || requestedItem?.selectedColor);
      if (Array.isArray(product?.variants) && product.variants.length && !variant) {
        return res.status(400).json({
          error: `Please select a valid color for ${getProductName(product)} before checkout.`
        });
      }

      const productData = {
        name: getProductName(product)
      };

      const description = clean(product?.description);
      if (description) productData.description = description.slice(0, 500);

      const image = getImage(variant || product);
      if (image) productData.images = [image];

      productData.metadata = {
        catalog_id: clean(product?.slug || product?.id || requestedItem?.id).slice(0, 500)
      };
      if (size) productData.metadata.size = size.slice(0, 500);
      if (color) productData.metadata.color = color.slice(0, 500);
      if (variant?.sku) productData.metadata.sku = clean(variant.sku).slice(0, 500);

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: productData,
          unit_amount: getUnitAmount(product)
        },
        quantity
      });
    }

    const subtotalCents = lineItems.reduce(
      (sum, item) => sum + item.price_data.unit_amount * item.quantity,
      0
    );

    const promoCode = clean(
      body.promoCode || body.promo_code || body.discountCode || body.discount_code
    ).toUpperCase();

    const customerEmail = clean(
      body.customerEmail || body.customer_email || body.email
    );

    const orderNumber = clean(
      body.orderNumber || body.order_number || makeOrderNumber()
    );

    if (promoCode === WELCOME_SHIPPING_CODE) {
      if (!customerEmail) {
        return res.status(400).json({
          error: 'Enter your email to use your FREESHIP welcome code.'
        });
      }
      let repeatCustomer = false;
      try {
        repeatCustomer = await hasPreviousOrder(stripe, customerEmail.toLowerCase());
      } catch (lookupError) {
        // Never block a sale because the lookup failed; log it and honor the code.
        console.error('FREESHIP first-order lookup failed:', lookupError);
      }
      if (repeatCustomer) {
        return res.status(400).json({
          error: 'FREESHIP is a welcome code for first orders only. Remove it to continue. Orders over $150 always ship free.'
        });
      }

      // Only Private Access subscribers may use FREESHIP. If the lookup itself
      // fails (site down), the code is honored so a sale is never blocked.
      const eligible = await isPrivateAccessEligible(customerEmail.toLowerCase());
      if (eligible === false) {
        return res.status(400).json({
          error: 'FREESHIP is the Private Access welcome code. Use the email you joined Private Access with, or remove the code to continue. Orders over $150 always ship free.'
        });
      }
    }

    // Campaign code (e.g. BLACKFRIDAY25): shared, any order, within its sale window.
    let campaign = null;
    if (promoCode && Object.prototype.hasOwnProperty.call(CAMPAIGN_CODES, promoCode)) {
      const c = CAMPAIGN_CODES[promoCode];
      const now = Date.now();
      if (now < Date.parse(c.starts)) {
        return res.status(400).json({ error: 'This code is not active yet. Remove it to continue.' });
      }
      if (now > Date.parse(c.ends)) {
        return res.status(400).json({ error: `The ${c.label} offer has ended. Remove the code to continue.` });
      }
      campaign = { code: promoCode, ...c };
    }

    // The Private Edit personal code: 10% off + complimentary shipping on a first order.
    let privateEdit = null;
    if (promoCode && promoCode !== WELCOME_SHIPPING_CODE && !campaign) {
      if (!PRIVATE_EDIT_CODE_PATTERN.test(promoCode)) {
        return res.status(400).json({
          error: 'This promo code is not valid. Check the code and try again, or remove it to continue.'
        });
      }
      if (!customerEmail) {
        return res.status(400).json({
          error: 'Enter the email you joined the Private Edit with to use your code.'
        });
      }

      const check = await validatePrivateEditCode(promoCode, customerEmail.toLowerCase());
      if (!check) {
        return res.status(503).json({
          error: 'We could not verify your Private Edit code just now. Please try again in a moment.'
        });
      }
      if (!check.valid) {
        return res.status(400).json({
          error: `${check.message || 'This Private Edit code cannot be used.'} Remove it to continue.`
        });
      }

      // Second first-order check against Stripe's own records.
      let repeatCustomer = false;
      try {
        repeatCustomer = await hasPreviousOrder(stripe, customerEmail.toLowerCase());
      } catch (lookupError) {
        console.error('Private Edit first-order lookup failed:', lookupError);
      }
      if (repeatCustomer) {
        return res.status(400).json({
          error: 'Your Private Edit code is valid on your first order only. Remove it to continue.'
        });
      }

      privateEdit = {
        code: String(check.code || promoCode),
        percentOff: Number(check.percent_off) || 10,
        freeShipping: check.free_shipping !== false
      };
    }

    const countriesEnv =
      process.env.STRIPE_ALLOWED_COUNTRIES ||
      process.env.ALLOWED_SHIPPING_COUNTRIES ||
      'US';

    const allowedCountries = String(countriesEnv)
      .split(',')
      .map((country) => country.trim().toUpperCase())
      .filter(Boolean);

    const sessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      client_reference_id: orderNumber,
      success_url:
        'https://j-hinton.com/order-confirmation.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:
        'https://j-hinton.com/checkout.html?cancelled=1',
      billing_address_collection: 'auto',
      shipping_address_collection: {
        allowed_countries: allowedCountries.length ? allowedCountries : ['US']
      },
      shipping_options: buildShippingOptions(subtotalCents, promoCode, Boolean(privateEdit?.freeShipping)),
      allow_promotion_codes: false, // promo codes are entered on j-hinton.com checkout (FREESHIP is handled above)
      phone_number_collection: { enabled: true },
      metadata: {
        order_number: orderNumber,
        source: 'j-hinton.com',
        shipping_promo: promoCode === WELCOME_SHIPPING_CODE ? WELCOME_SHIPPING_CODE : '',
        welcome_code: privateEdit ? privateEdit.code : '',
        welcome_discount_percent: privateEdit ? String(privateEdit.percentOff) : '',
        campaign_code: campaign ? campaign.code : '',
        campaign_discount_percent: campaign ? String(campaign.percentOff) : ''
      }
    };

    if (privateEdit) {
      const coupon = await getPrivateEditCoupon(stripe, privateEdit.percentOff);
      sessionParams.discounts = [{ coupon: coupon.id }];
      // Stripe accepts either discounts or allow_promotion_codes, not both.
      delete sessionParams.allow_promotion_codes;
    }

    if (campaign) {
      const coupon = await getCampaignCoupon(stripe, campaign.code, campaign);
      sessionParams.discounts = [{ coupon: coupon.id }];
      delete sessionParams.allow_promotion_codes;
    }

    if (customerEmail) {
      sessionParams.customer_email = customerEmail;
    }

    if (
      String(process.env.STRIPE_AUTOMATIC_TAX || '').toLowerCase() === 'true'
    ) {
      sessionParams.automatic_tax = { enabled: true };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    if (!session?.url) {
      throw new Error('Stripe did not return a checkout URL.');
    }

    return res.status(200).json({
      url: session.url,
      sessionId: session.id,
      orderNumber
    });
  } catch (error) {
    console.error('Checkout session error:', error);

    return res.status(500).json({
      error:
        process.env.NODE_ENV === 'development'
          ? (error?.message || 'Unable to create checkout session.')
          : 'Unable to create checkout session. Please try again.'
    });
  }
}
