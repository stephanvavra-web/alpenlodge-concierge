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
