# Stripe Flow – Step 1 (Quote + DB)

Diese Änderung macht den Concierge-Backend-Server **Stripe-ready**, ohne schon Stripe einzubauen.

**Was ist neu?**

1. **Persistente Quote/Angebot-Objekte** (DB oder In-Memory-Fallback)
2. Neue Endpoint-Namespaces:
   - `POST /api/booking/availability` (Alias – damit das Frontend NICHT mehr auf `/concierge/*` fallbacken muss)
   - `POST /api/booking/book` (Alias)
3. Neue Quote-API:
   - `POST /api/booking/quote` (liefert Preis + Naechte + price/night und speichert Quote)
   - `GET /api/booking/quote/:quoteId` (Debug)
4. DB Debug:
   - `GET /api/debug/db`

---

## Render / ENV Setup

### Pflicht (wie bisher)
- `OPENAI_API_KEY`
- `SMOOBU_API_KEY`
- `SMOOBU_CUSTOMER_ID`

### Empfohlen
- `BOOKING_TOKEN_SECRET` (aktiviert signierte Offer-Tokens)

### Neu (DB)
- `DATABASE_URL` (**Postgres Connection String**)

Wenn `DATABASE_URL` fehlt oder die DB-Verbindung nicht klappt, faellt der Server automatisch auf **In-Memory** zurueck.
> In-Memory ist fuer Stripe/Payments nicht geeignet (verliert Daten beim Restart) – fuer Tests ok.

Optional:
- `BOOKING_QUOTE_TTL_MIN` (Default: `15`) – Lebensdauer der Quote
- `PGSSLMODE=require` oder `DB_SSL=true` (falls deine DB SSL verlangt)

---

## Neue Endpoints

### 1) Availability (Alias)

`POST /api/booking/availability`

Body (wie bisher):
```json
{ "arrivalDate": "2026-01-05", "departureDate": "2026-01-07", "guests": 3 }
```

### 2) Quote (Step 1)

`POST /api/booking/quote`

Body (flexibel – diese Felder werden akzeptiert):
```json
{
  "apartmentId": 1590529,
  "from": "2026-01-05",
  "to": "2026-01-07",
  "guests": 3,
  "discountCode": "OPTIONAL"
}
```

Response (Beispiel):
```json
{
  "ok": true,
  "quoteId": "...",
  "expiresAt": "...",
  "stay": { "arrivalDate": "2026-01-05", "departureDate": "2026-01-07", "nights": 2, "guests": 3 },
  "price": { "amount": 906, "amountCents": 90600, "currency": "EUR", "perNight": 453 }
}
```

### 3) Quote holen (Debug)

`GET /api/booking/quote/:quoteId`

### 4) DB Debug

`GET /api/debug/db`

---

## Quick Tests

### DB Status
```bash
curl -s https://alpenlodge-concierge.onrender.com/api/debug/db | python3 -m json.tool
```

### Quote erstellen
```bash
curl -s https://alpenlodge-concierge.onrender.com/api/booking/quote \
  -H 'content-type: application/json' \
  -d '{"apartmentId":1590529,"from":"2026-01-05","to":"2026-01-07","guests":3}' \
| python3 -m json.tool
```

---

## Was kommt als naechstes (Step 2)

- `POST /api/payment/stripe/create-intent`
- Stripe PaymentIntent wird **nur** aus einer gespeicherten `quoteId` erstellt.
- Webhook `payment_intent.succeeded` loest erst dann die finale Buchung in Smoobu aus.

