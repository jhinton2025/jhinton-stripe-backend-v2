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
    product?.name
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

function buildShippingOptions(subtotalCents) {
  const standard =
    subtotalCents >= 15000
      ? {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: 'usd' },
            display_name: 'Complimentary Standard Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 2 },
              maximum: { unit: 'business_day', value: 5 }
            }
          }
        }
      : {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 1295, currency: 'usd' },
            display_name: 'Standard Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 2 },
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
      const color = clean(requestedItem?.color);

      const productData = {
        name: getProductName(product)
      };

      const description = clean(product?.description);
      if (description) productData.description = description.slice(0, 500);

      const image = getImage(product);
      if (image) productData.images = [image];

      productData.metadata = {
        catalog_id: clean(product?.slug || product?.id || requestedItem?.id).slice(0, 500)
      };
      if (size) productData.metadata.size = size.slice(0, 500);
      if (color) productData.metadata.color = color.slice(0, 500);

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

    const customerEmail = clean(
      body.customerEmail || body.customer_email || body.email
    );

    const orderNumber = clean(
      body.orderNumber || body.order_number || makeOrderNumber()
    );

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
      shipping_options: buildShippingOptions(subtotalCents),
      allow_promotion_codes: true,
      phone_number_collection: { enabled: true },
      metadata: {
        order_number: orderNumber,
        source: 'j-hinton.com'
      }
    };

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
