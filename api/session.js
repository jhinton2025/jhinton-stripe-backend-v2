import Stripe from 'stripe';
import { applyCors } from '../cors.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const sessionId = String(req.query?.session_id || '');
  if (!sessionId.startsWith('cs_')) {
    return res.status(400).json({ error: 'Invalid checkout session.' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    return res.status(200).json({
      orderNumber: session.client_reference_id || session.metadata?.order_number || null,
      customerEmail: session.customer_details?.email || session.customer_email || null,
      amountTotal: session.amount_total,
      currency: session.currency,
      paymentStatus: session.payment_status,
      status: session.status
    });
  } catch (error) {
    console.error('Session lookup error:', error);
    return res.status(404).json({ error: 'Order confirmation could not be found.' });
  }
}
