import Stripe from 'stripe';
import { sendAdminOrderNotification } from '../lib/admin-order-email.js';

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

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ ok: false, error: 'STRIPE_SECRET_KEY is not configured.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const requestedDays = Number(req.body?.days || 30);
  const days = Math.min(Math.max(Number.isFinite(requestedDays) ? requestedDays : 30, 1), 180);
  const requestedMax = Number(req.body?.maxOrders || 100);
  const maxOrders = Math.min(Math.max(Number.isFinite(requestedMax) ? requestedMax : 100, 1), 100);
  const createdGte = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

  const summary = {
    ok: true,
    days,
    scanned: 0,
    sent: 0,
    skippedAlreadySent: 0,
    skippedNotPaid: 0,
    failed: 0,
    results: []
  };

  try {
    const sessions = await stripe.checkout.sessions.list({
      limit: maxOrders,
      created: { gte: createdGte }
    });

    for (const session of sessions.data) {
      summary.scanned += 1;

      if (session.payment_status !== 'paid') {
        summary.skippedNotPaid += 1;
        continue;
      }

      if (session.metadata?.admin_order_email_sent === 'true') {
        summary.skippedAlreadySent += 1;
        continue;
      }

      try {
        const result = await sendAdminOrderNotification(stripe, session);
        if (result.sent) {
          summary.sent += 1;
          summary.results.push({
            orderNumber: result.orderNumber,
            sessionId: result.sessionId,
            sent: true
          });
        } else if (result.reason === 'already_sent') {
          summary.skippedAlreadySent += 1;
        }
      } catch (error) {
        summary.failed += 1;
        summary.results.push({
          orderNumber: session.client_reference_id || session.id,
          sessionId: session.id,
          sent: false,
          error: error?.message || 'Unknown error'
        });
      }
    }

    return res.status(200).json(summary);
  } catch (error) {
    console.error('J.HINTON admin email backfill error:', error);
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Unable to backfill admin order emails.'
    });
  }
}
