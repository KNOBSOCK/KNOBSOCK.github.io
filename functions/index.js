// ============================================================================
// KNOBSOCK STORE — Cloud Functions
//
// Two functions, both deliberately small:
//
//   createCheckoutSession  — the browser (cart.html) calls this with just a
//                             list of { productId, quantity, size }. It looks
//                             up the REAL price of each product straight from
//                             Firestore (never trusting a price the browser
//                             sends — devtools can edit anything client-side,
//                             so the price a customer is actually charged has
//                             to be decided here, not there) and hands back a
//                             Stripe-hosted checkout URL to redirect to.
//
//   stripeWebhook          — Stripe calls this directly (never the browser)
//                             the moment a payment actually succeeds. This is
//                             the ONLY place an order gets written to
//                             Firestore, and only after Stripe's signature on
//                             the request proves it really came from Stripe —
//                             see the signature check below before touching
//                             anything else in that function.
//
// Neither of these is wired to anything live yet — see functions/README.md
// for the setup this still needs (a Stripe account, Firebase's Blaze plan,
// and a few `firebase` CLI commands) before either function does anything.
// ============================================================================

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();

// Set via `firebase functions:secrets:set STRIPE_SECRET_KEY` /
// `STRIPE_WEBHOOK_SECRET` — never hardcoded here, and never committed
// anywhere in this repo. See functions/README.md.
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

// Where Stripe sends the customer back to after paying (or backing out).
// Update this if the site ever moves off this domain.
const SITE_URL = 'https://knobsock.net';

// No pinned apiVersion on purpose — that ties this integration to whatever
// API version the installed `stripe` package version itself targets, which
// is the behavior Stripe's own SDK docs recommend, rather than this file
// guessing at a specific dated version string that could drift out of date.
function stripeClient() {
  return new Stripe(STRIPE_SECRET_KEY.value());
}

// ----------------------------------------------------------------------
// createCheckoutSession
// ----------------------------------------------------------------------
exports.createCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const items = Array.isArray(request.data && request.data.items) ? request.data.items : [];
    if (!items.length) {
      throw new HttpsError('invalid-argument', 'Cart is empty.');
    }
    if (items.length > 50) {
      throw new HttpsError('invalid-argument', 'Too many line items.');
    }

    const lineItems = [];

    for (const raw of items) {
      const productId = String((raw && raw.productId) || '');
      const quantity = Math.max(1, Math.min(20, parseInt(raw && raw.quantity, 10) || 1));
      const size = raw && raw.size ? String(raw.size).slice(0, 40) : '';
      if (!productId) continue;

      // eslint-disable-next-line no-await-in-loop -- a cart is a handful of
      // items at most; a Promise.all here would trade a few ms for meaningfully
      // harder-to-follow code.
      const snap = await db.collection('store_products').doc(productId).get();
      if (!snap.exists) continue;
      const product = snap.data();
      if (product.active === false) continue;

      lineItems.push({
        quantity,
        price_data: {
          currency: 'usd',
          unit_amount: product.priceCents,
          product_data: {
            name: size ? `${product.title} (${size})` : product.title,
            images: Array.isArray(product.images) && product.images[0] ? [product.images[0]] : undefined,
            // Read back out of the completed session in stripeWebhook below
            // (via price.product.metadata) to tie each line item back to a
            // real product doc and the size the customer picked — Stripe's
            // own `description` on a line item is just the display name.
            metadata: { productId, size }
          }
        }
      });
    }

    if (!lineItems.length) {
      throw new HttpsError('invalid-argument', "None of the items in this cart are available anymore — they may have been removed from the store.");
    }

    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: `${SITE_URL}/confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/cart.html`,
      // A fixed country list rather than "collect from anywhere" — shipping
      // somewhere not actually supported yet is worse than not offering it.
      // Add countries here once shipping there is actually sorted out.
      shipping_address_collection: { allowed_countries: ['US', 'CA'] },
      phone_number_collection: { enabled: true }
    });

    return { url: session.url };
  }
);

// ----------------------------------------------------------------------
// stripeWebhook
// ----------------------------------------------------------------------
exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const stripe = stripeClient();

    // This is the entire security model for this endpoint: it's a public
    // URL (Stripe has to be able to reach it), so the signature is what
    // proves a request actually came from Stripe and wasn't just someone
    // POSTing a fake "it's paid" event at this URL to get free merch.
    // req.rawBody (the exact, unparsed request bytes) is required here —
    // constructEvent re-computes the signature itself, and re-serializing
    // an already-parsed JSON body doesn't byte-for-byte match what Stripe
    // originally signed.
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      logger.error('Webhook signature check failed', err);
      res.status(400).send('Signature verification failed');
      return;
    }

    if (event.type !== 'checkout.session.completed') {
      res.status(200).send('ignored');
      return;
    }

    try {
      // Re-retrieved (rather than read straight off the webhook payload)
      // specifically to expand line_items — those aren't included on the
      // event object itself, only on a direct retrieve.
      const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
        expand: ['line_items.data.price.product']
      });

      const items = ((session.line_items && session.line_items.data) || []).map((li) => {
        const product = li.price && li.price.product; // the expand above turns this into the full object, not just an id
        const meta = (product && product.metadata) || {};
        return {
          title: li.description || '',
          quantity: li.quantity,
          unitPriceCents: li.price ? li.price.unit_amount : null,
          productId: meta.productId || null,
          size: meta.size || ''
        };
      });

      // Stripe moved shipping off the session's top-level `shipping_details`
      // and into `collected_information.shipping_details` partway through
      // 2025 (the "Basil" API version) — checking both here means this
      // keeps working whichever API version this Stripe account actually
      // ends up pinned to, rather than this file guessing at one.
      const collected = session.collected_information || {};
      const shippingDetails = collected.shipping_details || session.shipping_details || {};
      const customerDetails = session.customer_details || {};
      const addr = shippingDetails.address || customerDetails.address || {};

      const orderRef = db.collection('store_orders').doc(session.id);

      await db.runTransaction(async (tx) => {
        const existing = await tx.get(orderRef);
        // Stripe retries webhook deliveries — a doc keyed by the session id
        // means a retry just re-finds the same doc instead of creating a
        // second order, but only if it bails out here BEFORE touching the
        // order-number counter below, or a retry would burn an extra number.
        if (existing.exists) return;

        const counterRef = db.collection('store_meta').doc('orderCounter');
        const counterSnap = await tx.get(counterRef);
        const next = ((counterSnap.exists && counterSnap.data().count) || 1000) + 1;
        tx.set(counterRef, { count: next }, { merge: true });

        tx.set(orderRef, {
          orderNumber: 'KS-' + next,
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent || null,
          customerName: shippingDetails.name || customerDetails.name || '',
          customerEmail: customerDetails.email || '',
          customerPhone: customerDetails.phone || '',
          shippingAddress: {
            line1: addr.line1 || '',
            line2: addr.line2 || '',
            city: addr.city || '',
            state: addr.state || '',
            postalCode: addr.postal_code || '',
            country: addr.country || ''
          },
          items,
          subtotalCents: session.amount_subtotal,
          shippingCents: (session.total_details && session.total_details.amount_shipping) || 0,
          taxCents: (session.total_details && session.total_details.amount_tax) || 0,
          totalCents: session.amount_total,
          currency: session.currency,
          paymentStatus: session.payment_status,
          fulfillmentStatus: 'unfulfilled',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      res.status(200).send('ok');
    } catch (err) {
      logger.error('Failed to record order for session ' + event.data.object.id, err);
      // 500 so Stripe automatically retries this same event later instead
      // of the order just silently never showing up in the admin.
      res.status(500).send('failed');
    }
  }
);
