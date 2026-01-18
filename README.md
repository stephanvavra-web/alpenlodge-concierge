# ALPENLODGE_BACKEND_ALL_IN_ONE_FIX (v58)

Includes:
- /concierge/availability + /concierge/book
- /api/booking/availability + /api/booking/book (aliases)
- Stripe create-intent + webhook -> Smoobu booking (DB + idempotent)
- /api/debug/db

Env (Render):
DATABASE_URL, SMOOBU_API_KEY, SMOOBU_CUSTOMER_ID, BOOKING_TOKEN_SECRET,
STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET
