# Alpenlodge — Chat Snapshot (chat.alpenlodge.info)

Ziel: Maschinenlesbare Verfuegbarkeit + Tagespreise (Smoobu Rates) + Wohnungsdetails.

## Endpunkte

HTML Index
- GET / (oder /index.html)
- Alias: GET /chat (oder /chat/index.html)

JSON Snapshot
- GET /api/chat/snapshot
- Aliases: GET /chat/snapshot, /chat/snapshot.json, /chat/api
- Datei: /chat/snapshot.json (wird beim Refresh neu geschrieben)

Debug
- GET /api/debug/chat (zeigt ob index.html/snapshot.json geschrieben wurden)

## Refresh

Primär per **Smoobu Webhooks** (empfohlen):

- Smoobu schickt Events wie `updateRates`, `newReservation`, `updateReservation`, `cancelReservation`, `deleteReservation`.
- Bei jedem relevanten Event wird der Snapshot **debounced** neu gebaut.
- Zusaetzlich: Wenn eine Buchung ueber eure eigenen Endpunkte erfolgt (z.B. **/concierge/book** oder Stripe Webhook), wird der Snapshot ebenfalls automatisch refreshed.
- Der Refresh ist damit **event-driven** (keine starren Cron-Intervalle).

Fallback (optional):

- Der Snapshot wird in-memory gecached.
- Wenn er älter als `CHAT_SNAPSHOT_REFRESH_HOURS` ist, wird beim nächsten Request ein Refresh im Hintergrund getriggert und `meta.stale=true` gesetzt.

Bei jedem Refresh werden auch statische Dateien geschrieben: `/chat/index.html` + `/chat/snapshot.json`.

### Smoobu Webhook Setup

In Smoobu → **Einstellungen** → **API / Entwickler** eine Webhook-URL eintragen, z.B.:

`https://alpenlodge-concierge.onrender.com/api/smoobu/webhook?token=DEIN_TOKEN`

Wenn du `SMOOBU_WEBHOOK_TOKEN` setzt, muss der Query-Parameter `token` exakt passen.

## Env Vars (Minimum)

Pflicht:
- SMOOBU_API_KEY
- SMOOBU_CUSTOMER_ID

Optional:
- CHAT_SNAPSHOT_DAYS=100
- CHAT_SNAPSHOT_REFRESH_MODE=webhook   (webhook|interval|hybrid)
- CHAT_SNAPSHOT_REFRESH_HOURS=24       (Fallback-Max-Age für On-Demand Refresh)
- CHAT_SNAPSHOT_APT_DETAILS_TTL_HOURS=24
- CHAT_STATIC_DIR=/tmp/alpenlodge_chat (default)
- CHAT_STATIC_WRITE=true (default)
- CHAT_STATIC_SERVE=true (default)
- APP_BUILD=v53

Webhook Security (optional):
- SMOOBU_WEBHOOK_TOKEN=... (wenn gesetzt, muss ?token=... in der URL vorhanden sein)

## Format (Kurz)

Antwort:
{
  ok: true,
  meta: { ... },
  units: [
    {
      apartment_id,
      name,
      unit_id,
      category,
      details_url,
      description,
      description_fields,
      calendar: [ { date, available, price, min_length_of_stay } ]
    }
  ]
}

Hinweis: price ist pro Nacht/Tag aus Smoobu Rates. Fuer exakten Gesamtpreis (Rabatte/Fees) nutzt weiterhin /booking/checkApartmentAvailability.
