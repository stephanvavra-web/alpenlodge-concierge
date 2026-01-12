# Concierge Tests (Smoke)

Diese Smoke-Tests prüfen die wichtigsten Endpunkte des Alpenlodge-Concierge-Backends:

- Health + Debug-Endpunkte
- Knowledge-Guardrails (kein INTERNAL, Links nur in `links[]`)
- Listen-Selektion ("2") via `sessionId`
- Smoobu: Availability/Prices (ohne echte Buchung auszulösen)
- Admin-Guards (403 ohne Token, optional 200 mit Token)

> **Wichtig:** Die Smoke-Tests erstellen **keine** Buchung. Sie prüfen nur Verfügbarkeit/Preise.

## Quickstart (lokal)

1. Backend starten:
```bash
npm install
npm start
```

2. Smoke-Test ausführen:
```bash
npm run test:smoke
```

## Gegen Render / Test-Deploy

```bash
BASE_URL=https://alpenlodge-concierge.onrender.com npm run test:smoke
```

### Strict Mode

Strict Mode markiert auch "WARN" als Fehler (Exit-Code != 0) und erzwingt u.a.:

- `reply` darf keine http(s)-URLs enthalten (URLs nur via `links[]`)

```bash
BASE_URL=https://alpenlodge-concierge.onrender.com npm run test:smoke:strict
```

### Admin-only Checks (optional)

Für Admin-Endpunkte / Raw-Proxy (z.B. `/api/smoobu/raw/api/me`) gibst du zusätzlich den Token:

```bash
BASE_URL=https://alpenlodge-concierge.onrender.com \
ADMIN_TOKEN="..." \
npm run test:smoke
```

## Testdaten (Zeitraum / Gäste)

Standard:

- `TEST_ARRIVAL=2026-02-01`
- `TEST_DEPARTURE=2026-02-05`
- `TEST_GUESTS=2`

Überschreiben:

```bash
TEST_ARRIVAL=2026-03-10 TEST_DEPARTURE=2026-03-13 TEST_GUESTS=4 npm run test:smoke
```

---

Wenn der Test FAIL/WARN meldet, ist das ein Hinweis auf Regressionen (z.B. INTERNAL in `links[]`, ungültige URLs, oder URLs im Reply-Text).
