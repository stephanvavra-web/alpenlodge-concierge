# Patch v32 – Fullscreen Booking Wizard + Units API

## Was ist neu?
- **Frontend (`al-concierge.js`)**: Ein **Fullscreen Booking Wizard** ("Witcher of booking") direkt im Concierge.
  - Start-Shortcut **„Buchen“** öffnet den Wizard (kein Redirect auf `/buchen/`).
  - Wenn der User im Chat „buchen / booking / reservieren“ schreibt → Wizard öffnet.
  - **Alle Links** aus Quick-Actions öffnen **immer in neuem Tab/Fenster** (Rule: nicht "entführen").
  - Der Wizard lädt Units via **`GET /api/units`** und prüft Verfügbarkeit/Preis via **`POST /api/booking/availability`**.
  - Buchung wird über **`POST /api/booking/book`** mit dem `offerToken` durchgeführt.

- **Backend (`concierge-server.mjs`)**: Neue Endpoint(s)
  - `GET /api/units` → liefert `data/units.json` (optional `?category=Premium` / `?q=...`).
  - `GET /api/units/:apartmentId` → liefert eine Unit nach `smoobu_id`.

## Installation (empfohlen)

### Variante A – Dateien ersetzen
1. Ersetze in deinem Repo:
   - `al-concierge.js` durch die Version aus diesem Patch
   - `concierge-server.mjs` durch die Version aus diesem Patch
2. Deploy Frontend + Backend.

### Variante B – Git apply (wenn Pfade gleich sind)
```bash
git apply patch_v32_booking_wizard.diff
# ggf. zusätzlich (falls du nur backend patchen willst)
# git apply patch_v32_backend_units_api.diff
```

## Checks
- Backend:
  - `GET https://<backend>/api/units` sollte `{ok:true, units:[...]}` liefern.
  - `POST https://<backend>/api/booking/availability` mit `{arrivalDate,departureDate,apartments:[<id>],guests:2}` sollte `{offers:[...offerToken...]}` liefern.

- Frontend:
  - Concierge öffnen → Quick Action **Buchen** → Wizard fullscreen.
  - Kategorie → Unit → Daten → Angebot → Gastdaten → Buchen.

## Hinweis zum "verfügbar aber dann nicht buchbar" Problem
- Technisch kann das **immer** passieren, wenn zwischen Verfügbarkeits-Check und Buchung jemand anderes schneller bucht.
- Der Wizard nutzt aber **dieselben Smoobu Apartment IDs** wie die Availability-API, dadurch verschwindet das Problem, das durch falsche Mapping-IDs entsteht.
