import Stripe from 'stripe';
import nodemailer from 'nodemailer';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function esc(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function firstNameFrom(fullName = '') {
  const clean = String(fullName || '').trim().replace(/\s+/g, ' ');
  return clean ? clean.split(' ')[0] : '';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

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
      stripeSessionId = ''
    } = req.body || {};

    if (!orderNumber || !customerEmail) {
      return res.status(400).json({ ok: false, error: 'Order number and customer email are required.' });
    }

    let firstName = '';
    if (String(stripeSessionId).startsWith('cs_')) {
      try {
        const session = await stripe.checkout.sessions.retrieve(stripeSessionId);
        const fullName =
          session.customer_details?.name ||
          session.shipping_details?.name ||
          session.collected_information?.shipping_details?.name ||
          '';
        firstName = firstNameFrom(fullName);
      } catch (e) {
        console.warn('Could not retrieve customer name for processing email:', e?.message || e);
      }
    }

    const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
    const smtp = getSmtpConfig();

    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass }
    });

    const html = `<!doctype html>
<html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#111;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f3;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid #e8e8e5;">
<tr><td style="padding:30px 34px 22px;text-align:center;border-bottom:1px solid #ededeb;"><div style="font-size:24px;font-weight:700;letter-spacing:.18em;">J.HINTON</div></td></tr>
<tr><td style="padding:38px 34px 18px;">
<div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#777;">Order Update</div>
<h1 style="font-size:28px;font-weight:400;line-height:1.25;margin:12px 0 18px;">We’re preparing your order.</h1>
<p style="font-size:14px;line-height:1.7;color:#333;margin:0 0 16px;">${esc(greeting)}</p>
<p style="font-size:14px;line-height:1.7;color:#555;margin:0;">We’ve received your order and our team is now carefully preparing it for shipment. Your J.HINTON pieces are being reviewed and prepared before leaving our facility.</p>
<p style="font-size:14px;line-height:1.7;color:#555;margin:16px 0 0;">We’ll send you another email as soon as your order ships with your carrier and tracking information.</p>
</td></tr>
<tr><td style="padding:10px 34px 34px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f5;font-size:13px;">
<tr><td style="padding:18px;color:#777;">Order</td><td style="padding:18px;text-align:right;font-weight:600;">${esc(orderNumber)}</td></tr>
<tr><td style="padding:0 18px 18px;color:#777;">Status</td><td style="padding:0 18px 18px;text-align:right;">Processing</td></tr>
</table>
</td></tr>
<tr><td style="padding:0 34px 38px;">
<a href="https://j-hinton.com/order-status.html" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:14px 22px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;">View Order Status</a>
</td></tr>
<tr><td style="padding:24px 34px;background:#111;color:#fff;">
<div style="font-size:12px;line-height:1.7;color:#d7d7d7;">Thank you for choosing J.HINTON. Questions about your order? Contact Client Services at ordersupport@j-hinton.com.</div>
<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin-top:14px;">J.HINTON · New York Roots. Atlanta Ambition.</div>
</td></tr>
</table></td></tr></table></body></html>`;

    const text = `J.HINTON ORDER UPDATE

${greeting}

We’ve received your order and our team is now carefully preparing it for shipment.

Your J.HINTON pieces are being reviewed and prepared before leaving our facility. We’ll send another email as soon as your order ships with carrier and tracking information.

Order: ${orderNumber}
Status: Processing

View order status:
https://j-hinton.com/order-status.html

Thank you for choosing J.HINTON.
ordersupport@j-hinton.com

J.HINTON
New York Roots. Atlanta Ambition.`;

    await transporter.sendMail({
      from: smtp.from,
      to: customerEmail,
      replyTo: 'ordersupport@j-hinton.com',
      subject: `We’re Preparing Your J.HINTON Order — ${orderNumber}`,
      html,
      text
    });

    console.log('J.HINTON processing confirmation sent', {
      orderNumber,
      customerEmail,
      personalized: Boolean(firstName)
    });

    return res.status(200).json({ ok: true, sent: true, personalized: Boolean(firstName) });
  } catch (error) {
    console.error('J.HINTON processing confirmation error:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'Unable to send processing confirmation.' });
  }
}
