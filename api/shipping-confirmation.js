import nodemailer from 'nodemailer';

function esc(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST || 'smtp.hostinger.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || 'ordersupport@j-hinton.com';
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'J.HINTON <ordersupport@j-hinton.com>';
  if (!pass) throw new Error('SMTP_PASS is not configured.');
  return { host, port, user, pass, from };
}

function trackingLink(carrier, trackingNumber, suppliedUrl) {
  if (suppliedUrl) return suppliedUrl;
  const c = String(carrier || '').toLowerCase();
  const n = encodeURIComponent(String(trackingNumber || '').trim());
  if (!n) return 'https://j-hinton.com/order-status.html';
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  return 'https://j-hinton.com/order-status.html';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const expected = process.env.ORDER_SYNC_SECRET || '';
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const {
      orderNumber = '',
      customerEmail = '',
      carrier = '',
      trackingNumber = '',
      trackingUrl = '',
      estimatedDelivery = ''
    } = req.body || {};

    if (!orderNumber || !customerEmail || !trackingNumber) {
      return res.status(400).json({ ok: false, error: 'Order number, customer email, and tracking number are required.' });
    }

    const trackUrl = trackingLink(carrier, trackingNumber, trackingUrl);
    const smtp = getSmtpConfig();
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass }
    });

    const deliveryRow = estimatedDelivery
      ? `<tr><td style="padding:7px 0;color:#777;">Estimated delivery</td><td style="padding:7px 0;text-align:right;">${esc(estimatedDelivery)}</td></tr>`
      : '';

    const html = `<!doctype html>
<html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#111;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f3;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid #e8e8e5;">
<tr><td style="padding:30px 34px 22px;text-align:center;border-bottom:1px solid #ededeb;"><div style="font-size:24px;font-weight:700;letter-spacing:.18em;">J.HINTON</div></td></tr>
<tr><td style="padding:38px 34px 16px;"><div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#777;">Shipping Confirmation</div><h1 style="font-size:28px;font-weight:400;line-height:1.25;margin:12px 0 14px;">Your order is on its way.</h1><p style="font-size:14px;line-height:1.7;color:#555;margin:0;">Your J.HINTON order has been handed off for delivery. Tracking details are below.</p></td></tr>
<tr><td style="padding:14px 34px 24px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f5;font-size:13px;">
<tr><td style="padding:18px 18px 7px;color:#777;">Order</td><td style="padding:18px 18px 7px;text-align:right;font-weight:600;">${esc(orderNumber)}</td></tr>
<tr><td style="padding:7px 18px;color:#777;">Carrier</td><td style="padding:7px 18px;text-align:right;">${esc(carrier || 'Carrier')}</td></tr>
<tr><td style="padding:7px 18px;color:#777;">Tracking number</td><td style="padding:7px 18px;text-align:right;">${esc(trackingNumber)}</td></tr>
${deliveryRow.replaceAll('padding:7px 0', 'padding:7px 18px')}
</table></td></tr>
<tr><td style="padding:0 34px 38px;"><a href="${esc(trackUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:14px 22px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;">Track Package</a><div style="margin-top:16px;font-size:12px;color:#777;">You can also view the latest status at j-hinton.com/order-status.html.</div></td></tr>
<tr><td style="padding:24px 34px;background:#111;color:#fff;"><div style="font-size:12px;line-height:1.7;color:#d7d7d7;">Questions about your shipment? Contact J.HINTON Client Services at ordersupport@j-hinton.com.</div><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin-top:14px;">J.HINTON · New York Roots. Atlanta Ambition.</div></td></tr>
</table></td></tr></table></body></html>`;

    const text = `J.HINTON SHIPPING CONFIRMATION

Your order is on its way.

Order: ${orderNumber}
Carrier: ${carrier || 'Carrier'}
Tracking number: ${trackingNumber}
${estimatedDelivery ? `Estimated delivery: ${estimatedDelivery}\n` : ''}
Track package:
${trackUrl}

Order status:
https://j-hinton.com/order-status.html

Questions? ordersupport@j-hinton.com

J.HINTON
New York Roots. Atlanta Ambition.`;

    await transporter.sendMail({
      from: smtp.from,
      to: customerEmail,
      replyTo: 'ordersupport@j-hinton.com',
      subject: `Your J.HINTON Order Has Shipped — ${orderNumber}`,
      html,
      text
    });

    console.log('J.HINTON shipping confirmation sent', { orderNumber, customerEmail, carrier, trackingNumber });
    return res.status(200).json({ ok: true, sent: true });
  } catch (error) {
    console.error('J.HINTON shipping confirmation error:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'Unable to send shipping confirmation.' });
  }
}

