# PATCHLOG — Alpenlodge

## v22 — 2026-01-12 (ausgerollt)

- Frontend: „Infos & Links“ Block als HTML gerendert (klickbar), **bold** Rendering, mobile Header wird nicht mehr umgebaut.
- Backend: v22 war live (v22.16.0), aber die Ausgabe zeigte noch INTERNAL-Links/Quelle-Zeilen → v23 behebt das hart.

## v23 — 2026-01-12 15:17 +0100

**Base-State**
- concierge-server.mjs sha256: `a8a38e07702a0ece17c41319fe37deeb61a956f2fac4cd8b2db88ff5bdcef3fb`
- al-concierge.js sha256: `674c82a6414ac9921abdb3eaaa88290002df81fa3d64c6503509a7dc0c371096`

**Fixes (Backend)**
- **Knowledge-Antworten IMMER**, sobald eine Kategorie erkannt wird (z.B. „Skigebiete …“ → kein LLM-Freestyle mehr).
- **Reply-Text sauber:** keine `Link:`/`Quelle:`/URL-Strings mehr im Antworttext.
- **INTERNAL wird niemals als Link ausgegeben** (weder in `reply` noch in `links[]`), stattdessen nur Hinweis `intern bestätigt`.
- **Offizielle Verzeichnisse** werden nur noch als Fallback gezeigt, wenn **keine** Items gefunden wurden (keine Monster-Blöcke bei „Ausstattung“).
- `links[]` enthält nur echte `http(s)` URLs + Duplikat-Filter.
- Auswahl „2“: Details ohne Quelle-Zeile; INTERNAL-Links werden gefiltert.

**Tests (curl)**
- `Alpenlodge Ausstattung` → Liste + „intern bestätigt“, **kein** Quellenblock, `links[]` leer/fehlt.
- `Skigebiete im Umkreis 35 km` → Liste aus verified knowledge + Links-Block (nur echte URLs).
- Danach `2` → Detail ohne Quelle-Zeile, keine INTERNAL-Links.

## v24 — 2026-01-12 (Smoobu Booking + Quick Actions)

**Base-State (von v23)**
- concierge-server.mjs sha256: `a8a38e07702a0ece17c41319fe37deeb61a956f2fac4cd8b2db88ff5bdcef3fb`
- al-concierge.js sha256: `674c82a6414ac9921abdb3eaaa88290002df81fa3d64c6503509a7dc0c371096`

**Changes (Backend)**
- **Booking/Verfügbarkeit/Preise direkt über Smoobu** im Chat (deterministisch, keine Halluzinationen):
  - Erkennt Buchungs-Intents, fragt fehlende Daten ab (Anreise/Abreise/Personen) und ruft `/booking/checkApartmentAvailability` auf.
  - Antwort enthält **Preisvergleich** + **actions[]** (Buchen/Details/Andere Daten).
- **Units-Mapping**: neues File `data/units.json` (Website-URL + Smoobu-ID), wird vom Backend geladen für schöne Namen + Links.
- **/concierge/book gefixt**: erstellt Reservierungen über **`/api/reservations`** mit `arrival`/`departure` Feldern.
- **Security**: keine öffentlichen Booking/Reservation-Listen mehr über Proxy; `GET /api/smoobu/bookings*` ist jetzt **Admin-only** und mappt auf `/api/reservations`. `DELETE /api/smoobu/bookings/:id` mappt auf **Cancel**.

**Changes (Frontend)**
- **Quick-Action-Bar über dem Texteingabefeld** (Buttons/Chips).
- Start-Vorbelegung: **Buchen**, **Verfügbarkeit**, **Preise**.
- Unterstützt Backend `actions[]` → klickbare Nachfragen/Optionen (ohne Tippen).
- **Bold-Rendering** für `**Text**`.
- Links-Block Titel: **Infos & Links** (statt „Quellen“).

**New Hashes**
- concierge-server.mjs sha256: `d5d6425133126d310d821dc9d07026af3e8d79ff9dcb0ea873ecf71968f2deea`
- al-concierge.js sha256: `b42ac115aa09cc59463f47515413f0be6549d97aa46fb249ce5b5f0bb971d7dd`
- data/units.json sha256: `d9c1a647890d611f71754d6ed4c20d236b0735476f56809b63bac8d918d06b25`

## v25 — 2026-01-12 (Smoke-Tests / Funktionsabfrage)

**Ziel**
- Schneller "Smoke Test" um die wichtigsten Funktionen/Endpunkte automatisiert abzufragen.

**Changes**
- Neu: `tests/smoke.mjs` (Node Script) prüft:
  - Health + Debug Endpunkte (`/health`, `/api/debug/*`)
  - Knowledge-Guardrails (kein `INTERNAL` in reply/links, Links sind gültige URLs)
  - Listen-Selektion ("2") via `sessionId`
  - Booking-Chatflow (Verfügbarkeit/Preise) + `actions[]`
  - Smoobu Availability (`/api/smoobu/availability`)
  - Admin Guards (403 ohne Token, optional Admin-Checks)
- Neu: `README_TESTS.md` (Bedienung)
- `package.json`: neue Scripts `test:smoke` und `test:smoke:strict`

## v26 — 2026-01-13

**Base-State**
- concierge-server.mjs sha256: `d5d6425133126d310d821dc9d07026af3e8d79ff9dcb0ea873ecf71968f2deea`
- al-concierge.js sha256: `b42ac115aa09cc59463f47515413f0be6549d97aa46fb249ce5b5f0bb971d7dd`
- tests/smoke.mjs sha256: `2477c9ba8f962fcbbbc7ae0fcf4c7ed3bc299b8a2c98d0e650a096285a23905b`

**Changes**
- **Booking-Chatflow (Smoobu):**
  - **Personenzahl ist optional**, bis eine Unterkunft ausgewählt wird → der User sieht sofort Angebote & Preise (Basis: 1 Person).
  - **Flexible Datumseingabe**: ISO, `13.01.26`, `13.01`, `heute/morgen/übermorgen`, Monatsnamen (DE/EN).
  - Angebotsliste mit **Nummern-Auswahl** ("2") + Quick-Actions für Kategorie/Zurück/Andere Daten.
- **Knowledge-Antworten:**
  - Kein "Offizielle Quellen/Verzeichnisse" Text mehr und **keine URLs im reply** → Links ausschließlich über `links[]`.
  - Link-Labels neutral (kein "(Quelle)") + URLs werden aus `summary` entfernt.
- **Frontend (Widget):**
  - `Infos & Links` wird als **echter HTML-Block** gerendert (klickbar) und **nicht** in die Chat-History geschrieben.
  - Start-Chips erweitert um **Apartments/Suiten/Premium** (schneller Einstieg in Verfügbarkeit/Preise).
- **Smoke-Tests:**
  - Booking-Test ohne Gästeangabe.
  - Guardrails: Fail bei "Offizielle Quellen/Verzeichnisse" oder "(Quelle)" im reply, sowie "Quelle" im links[] label.

**New-State**
- concierge-server.mjs sha256: `c5061710e52b86d1e2651b168bd767dcf076c6117a9fbf9dc2dd40c96661755a`
- al-concierge.js sha256: `ef32cd40a4691b44ac6ad10b2be071306240a3b2a62c73f7a1ab7ef90166c216`
- tests/smoke.mjs sha256: `30fd18eef5196f967a8ee26c309eba33a546ab05f7c42c31acb19ce1219a9548`

## v29 — 2026-01-14 (Knowledge: alle JSONs aktiv)

**Base-State**
- concierge-server.mjs sha256: `c5061710e52b86d1e2651b168bd767dcf076c6117a9fbf9dc2dd40c96661755a`

**Changes (Backend)**
- **Knowledge Loader**: `KNOWLEDGE_FILE` kann Ordner **oder** Datei sein; Default ist der Ordner `knowledge/`.
  - Im Ordner werden **alle `*.json`** geladen (Dateiname egal), Schema wird erkannt, Inhalte werden **gemerged + dedupliziert**.
- **Neues Knowledge-Schema** unterstützt: `highlights` + `official_portals` (z.B. `concierge_knowledge_de_verified.json`).
- **Directories**: `sources` mit mehreren URLs werden sauber aufgesplittet (kein „URL1 | URL2“ Link mehr).
- **Debug**: `/api/debug/knowledge` liefert `mode/base/files[]/skipped[]` für klare Kontrolle, was wirklich aktiv ist.
- **Kategorie-Fix**: Wasser/Wellness vereinheitlicht auf `lakes_pools_wellness`, plus zusätzliche Kategorien (`activities`, `family`, `rental`) in Erkennung & Titelmapping.
- **Fallback-Directories** zeigen auch Einträge mit Kategorie `all` bzw. ohne Kategorie (nur wenn keine Items gefunden wurden).

**New Hash**
- concierge-server.mjs sha256: `31e7eb623991b4f0315f7cef2b06e9341c5db70f7cc517b4084fe52dc2e11c4d`
