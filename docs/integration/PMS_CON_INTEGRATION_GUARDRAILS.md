# PMS-con Integration Guardrails (Alpenlodge Concierge)

Stand: 17.05.2026  
Quelle: `/Users/stephanvavra/Downloads/PMS-con_Integration_Arbeitsanweisungen.md`

## Ziel
Diese Guardrails sichern bei der Integration in `pms-con` drei Dinge gleichzeitig:
1. Booking-Funktion der Website bleibt funktionsfähig.
2. Geschützter Datenbankbereich bleibt intakt.
3. Bestehende PMS-con-Funktionen bleiben erhalten (keine Regressionen).

## A. Was aktuell bereits vorhanden ist (Code-Status)
Datei: `concierge-server.mjs`

1. Signierte Offer-Tokens vorhanden
- `signOffer`, `verifyOffer`
- `BOOKING_TOKEN_SECRET` Pflicht für Offers/Booking

2. Stripe + DB-Basis vorhanden
- Tabelle `booking_payments`
- Tabelle `stripe_events` (Webhook-Dedupe-Basis)
- Stripe Webhook Endpoint vorhanden

3. Booking-API vorhanden
- `/api/booking/availability`
- `/concierge/book`
- Stripe Intent + Status-Endpunkte vorhanden

4. Rabatt-Engine serverseitig vorhanden
- Lead-Time + Long-Stay
- best-of, non-kumulativ
- Rabattkonsistenz in `autoDiscountApplied`, `prices[].discount`, `offers[].discount`

## B. Kritische Lücken vor vollständiger PMS-con-Integration
Diese Punkte müssen vor 100%-Cutover umgesetzt sein:

1. Availability-Hold/Lock vor Checkout
- Aktuell nicht als persistenter Lock mit TTL implementiert.
- Risiko: Doppelbuchung während Payment.

2. Persistenter Offer-Snapshot als DB-Objekt
- Token existiert, aber `offerId`/`offerHash` mit DB-Snapshot muss als SoT ergänzt werden.

3. Harte Idempotenz für Checkout/BookingIntent
- Ein Checkout darf nur einen BookingIntent erzeugen.
- Wiederholte Calls müssen denselben Intent zurückgeben.

4. Shadow-Mode read-only Flagging
- Parallelvergleich darf keine Stripe-Intents und keine PMS-Reservierung auslösen.

5. Rollback-Prozedur für offene Zahlungen
- Bei Feature-Flag-Rücknahme müssen offene `payment_succeeded`/`reservation_pending` Intents sauber abgearbeitet werden.

## C. Schutz des DB-Bereichs (verbindlich)

1. Neue Tabellen nur append-only ergänzen
- Keine destruktiven Migrationen auf `booking_payments` ohne Backfill-Plan.

2. Pflicht-Constraints
- `booking_intents.idempotency_key` UNIQUE
- `availability_locks` Unique-Key auf `(unit_id, check_in, check_out, status=active)` oder äquivalent
- `stripe_events.stripe_event_id` UNIQUE (bereits logisch vorhanden, technisch prüfen)

3. Zustandsmaschine erzwingen
- Erlaubte Status-Transitions serverseitig validieren.
- Keine direkten Statussprünge ohne Prüfung.

4. DB-Zugriff absichern
- Nur Service-Account mit minimalen Rechten.
- Kein Frontend-Zugriff auf interne Payment/Intent-Tabellen.

## D. Erhalt der PMS-con-Funktionen (Kompatibilitätsvertrag)

1. API-Felder dürfen nicht brechen
- `autoDiscountApplied`
- `prices[].discount`
- `offers[].discount`
- `price`, `priceBase`, `currency`

2. Endpunkte müssen weiter funktionieren
- `POST /api/booking/availability`
- `POST /concierge/book`
- `POST /api/payment/stripe/create-intent`
- `POST /api/payment/stripe/webhook`

3. Fehlermodell stabil halten
- Bestehende Frontend-Error-Flows nicht brechen (`400/409/500` Pattern).

## E. Feature-Flags für sichere Migration
Empfohlen (müssen in `pms-con` vorhanden sein):
- `pmsConAvailabilityEnabled`
- `pmsConOfferEnabled`
- `pmsConCheckoutEnabled`
- `pmsConWebhookProcessingEnabled`
- `pmsConShadowModeEnabled`
- `pmsConTrackingEnabled`

Reihenfolge:
1. Shadow Mode read-only
2. Availability
3. Offers
4. Checkout
5. Webhook processing

## F. Mindest-Regressionstests (Go/No-Go)

1. Rabatt
- 0–2/3–7/8–14/15–180 Tage
- 7/14/30 Nächte Long-Stay
- maxNights-Regeln funktionieren

2. Booking
- Doppelter Checkout-Call erzeugt keine Doppelbuchung
- Webhook-Event doppelt => keine zweite Reservierung
- Payment erfolgreich + PMS langsam => Retry-Pfad greift

3. Datenkonsistenz
- `autoDiscountApplied == prices[].discount == offers[].discount`
- `amount_paid == booked_total` aus Offer-Snapshot

## G. Konkreter Umsetzungsplan (kompakt)

Phase 1 (1 Woche)
- Discovery-Artefakte erstellen
- DB-Schema für `availability_locks`, `booking_intents`, `offer_snapshots`
- Shadow Mode read-only einbauen

Phase 2 (1 Woche)
- Offer-Snapshot + offerHash
- Checkout-Idempotenz
- Statusmaschine + Retry-Worker

Phase 3 (1 Woche)
- Stufenweiser Cutover via Feature-Flags
- Monitoring/Alerts
- Rollback-Drill mit offenen Zahlungen

## H. Nicht verhandelbare Go-Live-Kriterien
Go-Live nur wenn:
1. Availability-Hold aktiv.
2. Checkout idempotent.
3. Stripe-Webhook dedupliziert.
4. Offer-Snapshot persistiert.
5. Rollback mit offenen Zahlungen getestet.

