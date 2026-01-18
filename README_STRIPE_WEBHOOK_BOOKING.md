# Stripe Webhook → Smoobu Booking (v57)

This bundle contains the backend files required to run:
- Stripe PaymentIntent creation
- Stripe Webhook (POST only) with signature verification
- Idempotent booking into Smoobu after payment success
- Postgres persistence

## Required ENV (Render)
DATABASE_URL
SMOOBU_API_KEY
SMOOBU_CUSTOMER_ID
BOOKING_TOKEN_SECRET

STRIPE_SECRET_KEY
STRIPE_PUBLISHABLE_KEY
STRIPE_WEBHOOK_SECRET

## Stripe Webhook URL
https://alpenlodge-concierge.onrender.com/api/payment/stripe/webhook

Events:
- payment_intent.succeeded
- payment_intent.payment_failed
- payment_intent.canceled