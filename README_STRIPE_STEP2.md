# Alpenlodge Concierge – Stripe Payment Element (Step 2)

Dieses Paket baut auf **Stripe Step 1 (DB + Quote)** auf und ergänzt:

- `POST /api/payment/stripe/create-intent` (Stripe PaymentIntent + Payment Element)
- `POST /api/payment/stripe/webhook` (Zahlung bestätigt → **erst dann** Smoobu-Buchung)
- `GET  /api/payment/stripe/config` (Publishable Key fürs Frontend)
- `GET  /api/payment/stripe/status/:paymentId` (Polling fürs Frontend)

## Render – Environment Variables (Backend)

**Pflicht**

- `SMOOBU_API_KEY`
- `SMOOBU_CUSTOMER_ID`
- `BOOKING_TOKEN_SECRET` (beliebig/zufällig, z.B. 32+ Zeichen)
- `DATABASE_URL` (Render Postgres)

**Stripe**

- `STRIPE_SECRET_KEY` (sk_test_… / sk_live_…)
- `STRIPE_PUBLISHABLE_KEY` (pk_test_… / pk_live_…)
- `STRIPE_WEBHOOK_SECRET` (whsec_…)

Optional:

- `DOG_PRICE_PER_NIGHT` (Default: 10)
- `SMOOBU_TIMEOUT_MS` (Default: 25000)

## Stripe Dashboard – Webhook anlegen

Webhook URL (Render Service):

- `https://alpenlodge-concierge.onrender.com/api/payment/stripe/webhook`

Events auswählen:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`

Signing Secret (`whsec_…`) in Render als `STRIPE_WEBHOOK_SECRET` setzen.

## Test – DB

```
curl -i https://alpenlodge-concierge.onrender.com/api/debug/db
```

## Test – Stripe Config

```
curl -s https://alpenlodge-concierge.onrender.com/api/payment/stripe/config | python3 -m json.tool
```

## Ablauf (vereinfacht)

1. Frontend holt Verfügbarkeit/Preis (Smoobu)
2. Frontend erstellt serverseitiges Quote: `POST /api/booking/quote`
3. Frontend erstellt Intent: `POST /api/payment/stripe/create-intent` → `client_secret`
4. Frontend zeigt Payment Element + `confirmPayment`
5. Stripe Webhook bestätigt Zahlung → Backend bucht bei Smoobu
6. Frontend pollt `GET /api/payment/stripe/status/:paymentId`

