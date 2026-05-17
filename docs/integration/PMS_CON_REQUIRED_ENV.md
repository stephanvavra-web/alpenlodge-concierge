# PMS-con Required Environment

## Bereits bestehend (muss gesetzt bleiben)
- `OPENAI_API_KEY`
- `SMOOBU_API_KEY`
- `SMOOBU_CUSTOMER_ID`
- `BOOKING_TOKEN_SECRET`
- `DATABASE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- optional: `STRIPE_PUBLISHABLE_KEY`, `SMOOBU_CHANNEL_ID`

## Neu für PMS-con Schicht
- `PMS_CON_AVAILABILITY_ENABLED` (`true|false`)
- `PMS_CON_OFFER_ENABLED` (`true|false`)
- `PMS_CON_CHECKOUT_ENABLED` (`true|false`)
- `PMS_CON_WEBHOOK_PROCESSING_ENABLED` (`true|false`)
- `PMS_CON_SHADOW_MODE_ENABLED` (`true|false`, empfohlen initial `true`)
- `PMS_CON_OFFER_TTL_SECONDS` (default `1800`)
- `PMS_CON_LOCK_TTL_SECONDS` (default `900`)

## Sichere Startkonfiguration (ohne Risiko)
- `PMS_CON_SHADOW_MODE_ENABLED=true`
- alle anderen `PMS_CON_*_ENABLED=false`

Damit laufen die neuen Endpunkte read-only/testbar, ohne produktive Legacy-Flows zu beeinflussen.
