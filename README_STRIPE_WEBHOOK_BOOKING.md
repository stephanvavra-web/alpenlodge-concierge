# v57 — Stripe Webhook → Smoobu Booking (DB)

## Endpoints
- `GET  /api/payment/stripe/config`
- `POST /api/payment/stripe/create-intent`
- `POST /api/payment/stripe/webhook` (POST only)
- `GET  /api/payment/stripe/status/:paymentId`
- `GET  /api/debug/db`

## Render ENV (required)
Database:
- `DATABASE_URL`

Smoobu:
- `SMOOBU_API_KEY`
- `SMOOBU_CUSTOMER_ID`
- `BOOKING_TOKEN_SECRET`

Stripe:
- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`

Optional:
- `STRIPE_CURRENCY=eur`
- `DB_SSL=true` (or `PGSSLMODE=require`)

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`

Optional:
- `STRIPE_CURRENCY=eur`
- `DB_SSL=true` or `PGSSLMODE=require`

## Stripe dashboard
Webhook endpoint URL:
`https://alpenlodge-concierge.onrender.com/api/payment/stripe/webhook`

Select events:
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
