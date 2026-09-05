# KNOBSOCK Store — backend setup

This folder is the one piece of the site that isn't static HTML — it's a
pair of Firebase Cloud Functions that talk to Stripe. Nothing here does
anything yet. It needs a Stripe account, a Firebase billing change, and a
handful of one-time CLI commands before checkout actually works. Do this
whenever you're ready to actually take money, not before.

## What the two functions do

- **`createCheckoutSession`** — called by `cart.html` when someone clicks
  Checkout. Looks up real prices in Firestore and hands back a Stripe
  checkout URL.
- **`stripeWebhook`** — called by Stripe (not the browser) the moment a
  payment actually goes through. This is the only thing that writes an
  order into Firestore.

See the comments at the top of `index.js` for more on why it's split this
way.

## 1. Install the Firebase CLI, if you don't have it

```
npm install -g firebase-tools
firebase login
```

## 2. Upgrade the Firebase project to the Blaze plan

Cloud Functions that call anything outside Google's own services (Stripe,
here) require the pay-as-you-go **Blaze** plan — the free **Spark** plan
can't deploy them at all. Blaze still has a large free-usage tier every
month (2M function invocations, etc.), so for a store this size the actual
bill should be $0 most months, but a card has to be on file. Do this in the
Firebase console for the `chat-for-website-efee2` project (⚙️ → Usage and
billing → Modify plan) before step 5 below, or the deploy will just fail.

## 3. Create a Stripe account and grab your API keys

Sign up at Stripe if you haven't already. In the Dashboard, **stay in Test
mode** (the toggle in the top right) for everything below until you've
actually tested a full purchase — Test mode uses fake card numbers and
never touches real money, and Test/Live have entirely separate keys.

Developers → API keys gives you a **Secret key** (`sk_test_...`). Keep the
tab open; you'll need it in step 5.

## 4. Install dependencies

```
cd functions
npm install
```

## 5. Set your Stripe secret key

```
firebase functions:secrets:set STRIPE_SECRET_KEY
```

Paste the `sk_test_...` key when prompted. This stores it encrypted in
Google Secret Manager — it never goes into this repo, and `index.js` only
ever reads it via `STRIPE_SECRET_KEY.value()` at runtime.

## 6. Deploy the functions

```
firebase deploy --only functions
```

The output ends with a URL for `stripeWebhook`, something like
`https://us-central1-chat-for-website-efee2.cloudfunctions.net/stripeWebhook`.
Copy it.

## 7. Point a Stripe webhook at it

In the Stripe Dashboard (still in Test mode): Developers → Webhooks → Add
endpoint. Paste the URL from step 6, and for the event to listen for,
select just `checkout.session.completed`. After you create it, Stripe
shows a **Signing secret** (`whsec_...`) — that's the second secret:

```
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
```

Then deploy once more so the function picks it up:

```
firebase deploy --only functions
```

## 8. Deploy the Firestore/Storage rules

**Read `../firestore.rules` first** — it only defines rules for the new
store collections and says right at the top why it can't just be deployed
as-is on top of whatever's already live for chat/photos/video/music.
Once it's merged with your real current rules:

```
firebase deploy --only firestore:rules,storage
```

## 9. Test a full purchase in Test mode

Add something to the cart on `/store`, go through checkout using Stripe's
test card `4242 4242 4242 4242`, any future expiry, any CVC. Confirm:
- `confirmation.html` shows the order after a few seconds
- the order shows up under the Store → Orders tab in `/admin`

## 10. Go live

Only once a real test purchase above worked end to end: flip Stripe to
**Live mode**, grab the live secret key (`sk_live_...`), create a SEPARATE
live-mode webhook endpoint (test and live webhooks are entirely separate
in Stripe) pointed at the same function URL, and repeat steps 5–7 with the
live key/secret instead of the test ones.

## Worth knowing about, not built here

- **Shipping cost** — checkout currently charges $0 shipping. Stripe
  Checkout can offer real shipping rate options (Dashboard → Shipping
  rates), which then get passed into `createCheckoutSession` as
  `shipping_options` — not wired up yet.
- **Sales tax** — same story: Stripe Tax can calculate it automatically
  (small extra fee per transaction) if turned on in the Dashboard, but
  nothing here enables it.
- **Email receipts** — Stripe can auto-email a receipt on successful
  payment; toggle it under Dashboard → Settings → Customer emails.
- **Inventory limits** — nothing here stops a one-of-a-kind item from
  being bought twice in quick succession.
- **Refunds** — handled manually from the Stripe Dashboard for now.
