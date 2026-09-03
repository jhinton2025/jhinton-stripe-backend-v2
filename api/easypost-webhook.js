import crypto from 'crypto';
import { sendDeliveryStatusEmail } from './delivery-status-email.js';

export const config = { api: { bodyParser: false } };

async function readRaw(req) {
  const chunks=[];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifyEasyPostSignature(raw, signature, secret) {
  if(!signature || !secret) return false;
  const expected='hmac-sha256-hex='+crypto.createHmac('sha256',secret.normalize('NFKD')).update(raw).digest('hex');
  const a=Buffer.from(expected);
  const b=Buffer.from(String(signature));
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method Not Allowed'});

  try{
    const raw=await readRaw(req);
    const secret=process.env.EASYPOST_WEBHOOK_SECRET||'';
    const signature=req.headers['x-hmac-signature']||'';

    if(!verifyEasyPostSignature(raw,signature,secret)){
      return res.status(401).json({ok:false,error:'Invalid EasyPost webhook signature'});
    }

    const event=JSON.parse(raw.toString('utf8'));
    if(event?.description!=='tracker.updated'){
      return res.status(200).json({ok:true,ignored:true});
    }

    const tracker=event?.result||{};
    const status=String(tracker?.status||'').toLowerCase();
    if(!['out_for_delivery','delivered'].includes(status)){
      return res.status(200).json({ok:true,ignored:true,status});
    }

    const trackingNumber=String(tracker?.tracking_code||'').trim();
    if(!trackingNumber) return res.status(200).json({ok:true,ignored:true,reason:'no_tracking_code'});

    const estimatedDelivery=
      tracker?.carrier_detail?.est_delivery_date_local ||
      tracker?.est_delivery_date ||
      '';

    const syncSecret=process.env.ORDER_SYNC_SECRET||'';
    const response=await fetch('https://j-hinton.com/order-api/tracking-event.php',{
      method:'POST',
      headers:{
        'Authorization':`Bearer ${syncSecret}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        eventId:event?.id||`${tracker?.id||trackingNumber}:${status}:${event?.created_at||''}`,
        trackingNumber,
        status,
        carrier:tracker?.carrier||'',
        estimatedDelivery
      })
    });

    const data=await response.json().catch(()=>({}));
    if(!response.ok || !data?.ok){
      console.error('J.HINTON tracking-event sync failed',{status:response.status,data});
      return res.status(500).json({ok:false,error:data?.error||'Order tracking sync failed'});
    }

    if(data?.updated && data?.statusChanged && data?.customerEmail){
      try{
        await sendDeliveryStatusEmail(data);
      }catch(emailError){
        console.error('J.HINTON automatic delivery email failed:',emailError);
        // Return 500 so EasyPost retries. Hostinger event idempotency prevents duplicate DB history.
        // On retry, the order endpoint reports duplicate, so manual resend may be needed if SMTP repeatedly fails.
        return res.status(500).json({ok:false,error:'Status updated but delivery email failed'});
      }
    }

    console.log('J.HINTON EasyPost event processed',{
      eventId:event?.id,status,trackingNumber,orderNumber:data?.orderNumber||''
    });
    return res.status(200).json({ok:true,status,orderNumber:data?.orderNumber||''});
  }catch(error){
    console.error('J.HINTON EasyPost webhook error:',error);
    return res.status(500).json({ok:false,error:error?.message||'Webhook processing failed'});
  }
}
