# Alpenlodge Concierge – Smoobu Booking (public) + Admin Token

## Was ist neu?
- `/concierge/availability` liefert zusätzlich **offers** (pro Apartment ein `offerToken`).
- `/concierge/book` nimmt `offerToken` + Gastdaten und erstellt eine **Reservation in Smoobu**.
- Basic Rate-Limit (pro IP, default 30 Requests/Minute) gegen Spam.

## Benötigte Render Environment Variables
Pflicht:
- `OPENAI_API_KEY`
- `SMOOBU_API_KEY`

Empfohlen/neu:
- `BOOKING_TOKEN_SECRET` (z.B. `openssl rand -hex 32`) – signiert offerTokens (10 Minuten gültig)
- `SMOOBU_CHANNEL_ID` (Default `70` = Homepage, Alternative `13` = Direct booking)
- `BOOKING_RATE_LIMIT_PER_MIN` (Default `30`)

Admin-only (falls du /api/smoobu/* write endpoints nutzt):
- `ADMIN_TOKEN` (z.B. ebenfalls `openssl rand -hex 32`)

## Beispiel-Calls
### 1) Availability + offerTokens
POST `/concierge/availability`
```json
{"arrivalDate":"2026-02-01","departureDate":"2026-02-05","guests":2}
```

Response enthält:
```json
{
  "offers":[
    {"apartmentId":1590379,"price":906,"currency":"€","offerToken":"..."}
  ]
}
```

### 2) Booking
POST `/concierge/book`
```json
{
  "offerToken":"<aus availability>",
  "firstName":"Max",
  "lastName":"Mustermann",
  "email":"max@example.com",
  "phone":"+43 123 456",
  "adults":2,
  "children":0,
  "language":"de",
  "notice":"Bitte Babybett, wenn möglich."
}

Hinweis: Die interne Weiterleitung an Smoobu verwendet `arrivalDate`/`departureDate` (wie in der offiziellen Smoobu API Doku), nicht `arrival`/`departure`.
```

## Admin Token – woher?
Der `ADMIN_TOKEN` ist **kein** Smoobu-Token. Das ist ein von dir erzeugtes Secret zum Absichern von Admin-Endpoints.


## Frontend Booking API (ohne Concierge Chat)
- POST /api/booking/availability (alias zu /concierge/availability)
- POST /api/booking/book (alias zu /concierge/book)

Hinweis: Concierge-Chat Booking ist standardmäßig deaktiviert. Zum Aktivieren: `CONCIERGE_ENABLE_BOOKING_CHAT=true`.
