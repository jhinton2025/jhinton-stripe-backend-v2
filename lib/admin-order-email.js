import nodemailer from 'nodemailer';

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
  const adminEmail = process.env.ADMIN_ORDER_EMAIL || 'ordersupport@j-hinton.com';

  if (!pass) throw new Error('SMTP_PASS is not configured.');
  if (!adminEmail) throw new Error('ADMIN_ORDER_EMAIL is not configured.');

  return { host, port, user, pass, from, adminEmail };
}

function getShippingAddress(session) {
  return session?.shipping_details?.address ||
    session?.collected_information?.shipping_details?.address ||
    session?.customer_details?.address ||
    null;
}

function getShippingName(session) {
  return session?.shipping_details?.name ||
    session?.collected_information?.shipping_details?.name ||
    session?.customer_details?.name ||
    '';
}

function addressHtml(address) {
  if (!address) return 'Address provided at checkout';
  return [
    address.line1,
    address.line2,
    [address.city, address.state, address.postal_code].filter(Boolean).join(', '),
    address.country
  ].filter(Boolean).map(esc).join('<br>');
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

    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #e9e9e9;vertical-align:top;">
        <div style="font-size:14px;font-weight:600;color:#111;">${esc(item.description || product.name || 'J.HINTON Item')}</div>
        <div style="font-size:12px;color:#777;margin-top:4px;">${details}</div>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #e9e9e9;text-align:right;vertical-align:top;font-size:14px;color:#111;">${money(item.amount_total, currency)}</td>
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

export async function sendAdminOrderNotification(stripe, sessionOrId, options = {}) {
  const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.id;
  if (!sessionId) throw new Error('Stripe Checkout session ID is required.');

  const fullSession = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items.data.price.product']
  });

  if (fullSession.payment_status !== 'paid') {
    return { sent: false, reason: 'not_paid', sessionId };
  }

  if (!options.force && fullSession?.metadata?.admin_order_email_sent === 'true') {
    console.log('J.HINTON admin order notification already sent', sessionId);
    return { sent: false, reason: 'already_sent', sessionId };
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
  const customerEmail = fullSession?.customer_details?.email || fullSession?.customer_email || 'Not provided';
  const customerName = getShippingName(fullSession) || 'Not provided';
  const phone = fullSession?.customer_details?.phone || 'Not provided';
  const address = getShippingAddress(fullSession);

  const html = `<!doctype html>
<html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#111;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f3;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border:1px solid #e8e8e5;">
<tr><td style="padding:28px 34px 22px;text-align:center;background:#111;color:#fff;"><div style="font-size:24px;font-weight:700;letter-spacing:.18em;">J.HINTON</div><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#aaa;margin-top:8px;">New Paid Order</div></td></tr>
<tr><td style="padding:34px;">
<h1 style="font-size:25px;font-weight:400;margin:0 0 20px;">New order received — ${esc(orderNumber)}</h1>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;background:#f7f7f5;margin-bottom:24px;">
<tr><td style="padding:12px 16px;color:#777;">Customer</td><td style="padding:12px 16px;text-align:right;font-weight:600;">${esc(customerName)}</td></tr>
<tr><td style="padding:0 16px 12px;color:#777;">Email</td><td style="padding:0 16px 12px;text-align:right;">${esc(customerEmail)}</td></tr>
<tr><td style="padding:0 16px 12px;color:#777;">Phone</td><td style="padding:0 16px 12px;text-align:right;">${esc(phone)}</td></tr>
<tr><td style="padding:0 16px 12px;color:#777;">Stripe Session</td><td style="padding:0 16px 12px;text-align:right;font-size:11px;">${esc(fullSession.id)}</td></tr>
</table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${buildItemsHtml(lineItems, currency)}</table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;margin-top:20px;">
<tr><td style="padding:5px 0;color:#666;">Subtotal</td><td style="padding:5px 0;text-align:right;">${money(subtotal, currency)}</td></tr>
${discount ? `<tr><td style="padding:5px 0;color:#666;">Discount</td><td style="padding:5px 0;text-align:right;">-${money(discount, currency)}</td></tr>` : ''}
<tr><td style="padding:5px 0;color:#666;">Shipping</td><td style="padding:5px 0;text-align:right;">${money(shipping, currency)}</td></tr>
<tr><td style="padding:5px 0;color:#666;">Tax</td><td style="padding:5px 0;text-align:right;">${money(tax, currency)}</td></tr>
<tr><td style="padding:13px 0 0;font-weight:700;border-top:1px solid #ddd;">Total</td><td style="padding:13px 0 0;text-align:right;font-weight:700;border-top:1px solid #ddd;">${money(total, currency)}</td></tr>
</table>
<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#777;margin:28px 0 10px;">Ship To</div>
<div style="font-size:13px;line-height:1.7;color:#444;">${addressHtml(address)}</div>
</td></tr>
<tr><td style="padding:22px 34px;background:#111;color:#aaa;font-size:11px;">Internal J.HINTON order notification · ${esc(smtp.adminEmail)}</td></tr>
</table></td></tr></table></body></html>`;

  const text = `J.HINTON — NEW PAID ORDER\n\nOrder: ${orderNumber}\nCustomer: ${customerName}\nEmail: ${customerEmail}\nPhone: ${phone}\nStripe Session: ${fullSession.id}\n\n${buildItemsText(lineItems, currency)}\n\nSubtotal: ${money(subtotal, currency)}\n${discount ? `Discount: -${money(discount, currency)}\n` : ''}Shipping: ${money(shipping, currency)}\nTax: ${money(tax, currency)}\nTotal: ${money(total, currency)}\n\nShip to:\n${addressText(address)}\n`;

  await transporter.sendMail({
    from: smtp.from,
    to: smtp.adminEmail,
    replyTo: customerEmail !== 'Not provided' ? customerEmail : 'ordersupport@j-hinton.com',
    subject: `NEW J.HINTON ORDER — ${orderNumber} — ${money(total, currency)}`,
    html,
    text
  });

  await stripe.checkout.sessions.update(fullSession.id, {
    metadata: {
      ...(fullSession.metadata || {}),
      admin_order_email_sent: 'true'
    }
  });

  console.log('J.HINTON admin order notification sent', {
    orderNumber,
    sessionId: fullSession.id,
    adminEmail: smtp.adminEmail
  });

  return { sent: true, orderNumber, sessionId: fullSession.id, adminEmail: smtp.adminEmail };
    }
