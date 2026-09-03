import Stripe from 'stripe';
import getRawBody from 'raw-body';
import nodemailer from 'nodemailer';

export const config = {
  api: { bodyParser: false }
};

function money(cents, currency = 'usd') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: String(currency || 'usd').toUpperCase()
  }).format((Number(cents) || 0) / 100);
}

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

function getShippingAddress(session) {
  return session?.shipping_details?.address || session?.customer_details?.address || null;
}

function addressHtml(address) {
  if (!address) return 'Address provided at checkout';
  const lines = [
    address.line1,
    address.line2,
    [address.city, address.state, address.postal_code].filter(Boolean).join(', '),
    address.country
  ].filter(Boolean);
  return lines.map(esc).join('<br>');
}

function addressText(address) {
  if (!address) return 'Address provided at checkout';
  return [
    address.line1,
    address.line2,
    [address.city, address.state, address.postal_code].filter(Boolean).join(', '),
    address.country
  ].filter(Boolean).join('\n');
}

function buildItemsHtml(lineItems, currency) {
  return lineItems.map((item) => {
    const product = item?.price?.product || {};
    const metadata = product?.metadata || {};
    const details = [
      metadata.size ? `Size: ${esc(metadata.size)}` : '',
      metadata.color ? `Color: ${esc(metadata.color)}` : '',
      `Qty: ${Number(item.quantity) || 1}`
    ].filter(Boolean).join(' · ');

    return `
      <tr>
        <td style="padding:16px 0;border-bottom:1px solid #e9e9e9;vertical-align:top;">
          <div style="font-size:14px;font-weight:600;color:#111;">${esc(item.description || product.name || 'J.HINTON Item')}</div>
          <div style="font-size:12px;color:#777;margin-top:4px;">${details}</div>
        </td>
        <td style="padding:16px 0;border-bottom:1px solid #e9e9e9;text-align:right;vertical-align:top;font-size:14px;color:#111;">
          ${money(item.amount_total, currency)}
        </td>
      </tr>`;
  }).join('');
}

function buildItemsText(lineItems, currency) {
  return lineItems.map((item) => {
    const product = item?.price?.product || {};
    const metadata = product?.metadata || {};
    const details = [
      metadata.size ? `Size ${metadata.size}` : '',
      metadata.color ? `Color ${metadata.color}` : '',
      `Qty ${Number(item.quantity) || 1}`
    ].filter(Boolean).join(' · ');

    return `${item.description || product.name || 'J.HINTON Item'} — ${details} — ${money(item.amount_total, currency)}`;
  }).join('\n');
}

async function sendOrderConfirmation(stripe, session) {
  const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['line_items.data.price.product']
  });

  const customerEmail = fullSession?.customer_details?.email || fullSession?.customer_email;

  if (!customerEmail) {
    console.warn('J.HINTON order confirmation skipped: no customer email', fullSession.id);
    return { sent: false, reason: 'no_customer_email' };
  }

  if (fullSession?.metadata?.confirmation_email_sent === 'true') {
    console.log('J.HINTON order confirmation already sent', fullSession.id);
    return { sent: false, reason: 'already_sent' };
  }

  const smtp = getSmtpConfig();
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass }
  });

  const orderNumber = fullSession.client_reference_id || fullSession.metadata?.order_number || fullSession.id;
  const currency = fullSession.currency || 'usd';
  const lineItems = fullSession.line_items?.data || [];
  const subtotal = fullSession.amount_subtotal || 0;
  const discount = fullSession.total_details?.amount_discount || 0;
  const shipping = fullSession.shipping_cost?.amount_total || 0;
  const tax = fullSession.total_details?.amount_tax || 0;
  const total = fullSession.amount_total || 0;
  const address = getShippingAddress(fullSession);
  const customerName = fullSession?.customer_details?.name || '';
  const firstName = customerName ? customerName.trim().split(/\s+/)[0] : '';
  const greeting = firstName ? `Hello ${esc(firstName)},` : 'Hello,';

  const html = `<!doctype html>
<html>
<body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#111;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f3;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid #e8e8e5;">
        <tr><td style="padding:30px 34px 22px;text-align:center;border-bottom:1px solid #ededeb;"><div style="font-size:24px;font-weight:700;letter-spacing:.18em;">J.HINTON</div></td></tr>
        <tr><td style="padding:38px 34px 18px;">
          <div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#777;">Order Confirmation</div>
          <h1 style="font-size:28px;font-weight:400;line-height:1.25;margin:12px 0 14px;">Thank you for your order.</h1>
          <p style="font-size:14px;line-height:1.7;color:#555;margin:0 0 8px;">${greeting}</p>
          <p style="font-size:14px;line-height:1.7;color:#555;margin:0;">Your payment has been confirmed and your J.HINTON order is now being prepared.</p>
        </td></tr>
        <tr><td style="padding:14px 34px 24px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f5;"><tr><td style="padding:18px;font-size:12px;color:#777;text-transform:uppercase;letter-spacing:.08em;">Order</td><td style="padding:18px;text-align:right;font-size:14px;font-weight:600;">${esc(orderNumber)}</td></tr></table></td></tr>
        <tr><td style="padding:0 34px 8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${buildItemsHtml(lineItems, currency)}</table></td></tr>
        <tr><td style="padding:18px 34px 30px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;">
          <tr><td style="padding:5px 0;color:#666;">Subtotal</td><td style="padding:5px 0;text-align:right;">${money(subtotal, currency)}</td></tr>
          ${discount ? `<tr><td style="padding:5px 0;color:#666;">Discount</td><td style="padding:5px 0;text-align:right;">-${money(discount, currency)}</td></tr>` : ''}
          <tr><td style="padding:5px 0;color:#666;">Shipping</td><td style="padding:5px 0;text-align:right;">${money(shipping, currency)}</td></tr>
          <tr><td style="padding:5px 0;color:#666;">Tax</td><td style="padding:5px 0;text-align:right;">${money(tax, currency)}</td></tr>
          <tr><td style="padding:13px 0 0;font-weight:700;border-top:1px solid #ddd;">Total</td><td style="padding:13px 0 0;text-align:right;font-weight:700;border-top:1px solid #ddd;">${money(total, currency)}</td></tr>
        </table></td></tr>
        <tr><td style="padding:0 34px 30px;"><div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#777;margin-bottom:10px;">Shipping To</div><div style="font-size:13px;line-height:1.7;color:#444;">${addressHtml(address)}</div></td></tr>
        <tr><td style="padding:0 34px 38px;"><a href="https://j-hinton.com/order-status.html" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:14px 22px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;">View Order Status</a></td></tr>
        <tr><td style="padding:24px 34px;background:#111;color:#fff;"><div style="font-size:12px;line-height:1.7;color:#d7d7d7;">Questions about your order? Contact J.HINTON Client Services at ordersupport@j-hinton.com.</div><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin-top:14px;">J.HINTON · New York Roots. Atlanta Ambition.</div></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `J.HINTON ORDER CONFIRMATION\n\n${firstName ? `Hello ${firstName},` : 'Hello,'}\n\nYour payment has been confirmed and your J.HINTON order is now being prepared.\n\nOrder: ${orderNumber}\n\n${buildItemsText(lineItems, currency)}\n\nSubtotal: ${money(subtotal, currency)}\n${discount ? `Discount: -${money(discount, currency)}\n` : ''}Shipping: ${money(shipping, currency)}\nTax: ${money(tax, currency)}\nTotal: ${money(total, currency)}\n\nShipping to:\n${addressText(address)}\n\nView order status:\nhttps://j-hinton.com/order-status.html\n\nQuestions? ordersupport@j-hinton.com\n\nJ.HINTON\nNew York Roots. Atlanta Ambition.`;

  await transporter.sendMail({
    from: smtp.from,
    to: customerEmail,
    replyTo: 'ordersupport@j-hinton.com',
    subject: `J.HINTON Order Confirmation — ${orderNumber}`,
    html,
    text
  });

  await stripe.checkout.sessions.update(fullSession.id, {
    metadata: { ...(fullSession.metadata || {}), confirmation_email_sent: 'true' }
  });

  console.log('J.HINTON order confirmation sent', { orderNumber, sessionId: fullSession.id, customerEmail });
  return { sent: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).send('Stripe is not configured.');
  }

  const signature = req.headers['stripe-signature'];
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Webhook is not configured.');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const rawBody = await getRawBody(req);
    const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      console.log('J.HINTON paid order', {
        orderNumber: session.client_reference_id,
        sessionId: session.id,
        paymentStatus: session.payment_status
      });

      if (session.payment_status === 'paid') {
        try {
          await sendOrderConfirmation(stripe, session);
        } catch (emailError) {
          console.error('J.HINTON confirmation email error:', emailError);
          return res.status(500).json({
            received: true,
            emailSent: false,
            error: emailError?.message || 'Unable to send order confirmation.'
          });
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook signature error:', error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
}
