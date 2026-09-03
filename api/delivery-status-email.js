import Stripe from 'stripe';
import nodemailer from 'nodemailer';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function esc(value = '') {
  return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
}
function firstNameFrom(fullName='') {
  const clean=String(fullName||'').trim().replace(/\s+/g,' ');
  return clean ? clean.split(' ')[0] : '';
}
function smtpConfig() {
  const host=process.env.SMTP_HOST||'smtp.hostinger.com';
  const port=Number(process.env.SMTP_PORT||465);
  const user=process.env.SMTP_USER||'ordersupport@j-hinton.com';
  const pass=process.env.SMTP_PASS;
  const from=process.env.SMTP_FROM||'J.HINTON <ordersupport@j-hinton.com>';
  if(!pass) throw new Error('SMTP_PASS is not configured.');
  return {host,port,user,pass,from};
}

export async function sendDeliveryStatusEmail(data) {
  const { status, orderNumber, customerEmail, stripeSessionId='', carrier='', trackingNumber='', estimatedDelivery='' } = data;
  let firstName='';
  if(String(stripeSessionId).startsWith('cs_')){
    try{
      const session=await stripe.checkout.sessions.retrieve(stripeSessionId);
      firstName=firstNameFrom(
        session.customer_details?.name ||
        session.shipping_details?.name ||
        session.collected_information?.shipping_details?.name ||
        ''
      );
    }catch(e){
      console.warn('Could not retrieve name for delivery status email:',e?.message||e);
    }
  }

  const isDelivered=status==='delivered';
  const greeting=firstName?`Hi ${firstName},`:'Hello,';
  const heading=isDelivered?'Your J.HINTON order has been delivered.':'Your J.HINTON order is out for delivery.';
  const message=isDelivered
    ? 'Your package has been marked delivered by the carrier. We hope you enjoy your J.HINTON order.'
    : 'Your package is with the carrier and is scheduled for delivery today. Please keep an eye out for your delivery.';
  const subject=isDelivered
    ? `Your J.HINTON Order Has Been Delivered — ${orderNumber}`
    : `Your J.HINTON Order Is Out for Delivery — ${orderNumber}`;

  const smtp=smtpConfig();
  const transporter=nodemailer.createTransport({
    host:smtp.host,port:smtp.port,secure:smtp.port===465,auth:{user:smtp.user,pass:smtp.pass}
  });

  const html=`<!doctype html><html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#111;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f3;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid #e8e8e5;">
<tr><td style="padding:30px 34px 22px;text-align:center;border-bottom:1px solid #ededeb;"><div style="font-size:24px;font-weight:700;letter-spacing:.18em;">J.HINTON</div></td></tr>
<tr><td style="padding:38px 34px 18px;"><div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#777;">Delivery Update</div>
<h1 style="font-size:28px;font-weight:400;line-height:1.25;margin:12px 0 18px;">${esc(heading)}</h1>
<p style="font-size:14px;line-height:1.7;color:#333;margin:0 0 16px;">${esc(greeting)}</p>
<p style="font-size:14px;line-height:1.7;color:#555;margin:0;">${esc(message)}</p></td></tr>
<tr><td style="padding:10px 34px 34px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f5;font-size:13px;">
<tr><td style="padding:18px;color:#777;">Order</td><td style="padding:18px;text-align:right;font-weight:600;">${esc(orderNumber)}</td></tr>
<tr><td style="padding:0 18px 12px;color:#777;">Carrier</td><td style="padding:0 18px 12px;text-align:right;">${esc(carrier||'Carrier')}</td></tr>
<tr><td style="padding:0 18px 12px;color:#777;">Tracking</td><td style="padding:0 18px 12px;text-align:right;">${esc(trackingNumber)}</td></tr>
${estimatedDelivery?`<tr><td style="padding:0 18px 18px;color:#777;">Estimated delivery</td><td style="padding:0 18px 18px;text-align:right;">${esc(estimatedDelivery)}</td></tr>`:''}
</table></td></tr>
<tr><td style="padding:0 34px 38px;"><a href="https://j-hinton.com/order-status.html" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:14px 22px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;">View Order Status</a></td></tr>
<tr><td style="padding:24px 34px;background:#111;color:#fff;"><div style="font-size:12px;line-height:1.7;color:#d7d7d7;">Questions about your delivery? Contact J.HINTON Client Services at ordersupport@j-hinton.com.</div><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin-top:14px;">J.HINTON · New York Roots. Atlanta Ambition.</div></td></tr>
</table></td></tr></table></body></html>`;

  const text=`J.HINTON DELIVERY UPDATE

${greeting}

${heading}
${message}

Order: ${orderNumber}
Carrier: ${carrier||'Carrier'}
Tracking: ${trackingNumber}
${estimatedDelivery?`Estimated delivery: ${estimatedDelivery}\n`:''}
View order status:
https://j-hinton.com/order-status.html

J.HINTON
New York Roots. Atlanta Ambition.`;

  await transporter.sendMail({
    from:smtp.from,to:customerEmail,replyTo:'ordersupport@j-hinton.com',subject,html,text
  });
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method Not Allowed'});
  const expected=process.env.ORDER_SYNC_SECRET||'';
  const auth=req.headers.authorization||'';
  const provided=auth.startsWith('Bearer ')?auth.slice(7):'';
  if(!expected||!provided||provided!==expected) return res.status(401).json({ok:false,error:'Unauthorized'});
  try{
    if(!['out_for_delivery','delivered'].includes(req.body?.status)) return res.status(400).json({ok:false,error:'Unsupported status'});
    await sendDeliveryStatusEmail(req.body);
    return res.status(200).json({ok:true,sent:true});
  }catch(error){
    console.error('J.HINTON delivery status email error:',error);
    return res.status(500).json({ok:false,error:error?.message||'Unable to send delivery status email.'});
  }
}
