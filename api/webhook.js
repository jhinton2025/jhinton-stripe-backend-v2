import Stripe from 'stripe';
import getRawBody from 'raw-body';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const signature = req.headers['stripe-signature'];
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Webhook is not configured.');
  }

  try {
    const rawBody = await getRawBody(req);
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('J.HINTON paid order', {
        orderNumber: session.client_reference_id,
        sessionId: session.id,
        paymentStatus: session.payment_status
      });

      // Fulfillment hook:
      // This is the reliable server-side place to write the order to Supabase,
      // send internal notifications, decrement inventory, or trigger fulfillment.
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook signature error:', error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
}
