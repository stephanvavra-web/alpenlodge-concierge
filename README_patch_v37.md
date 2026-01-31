# Patch v37 – Chat‑Booking (autonom buchen) + Fullscreen‑UI

Dieses Patch macht den Concierge „buchungsfähig“ **im Chat**:
- Auswahl: Zeitraum → Unterkunft → (optional) Personenzahl
- Danach **Checkout‑Wizard im Chat**: Name → E‑Mail → Telefon → Straße → PLZ/Ort → Land → Review → Bestätigen
- Beim Bestätigen wird **nochmals live geprüft**, ob die Unterkunft noch frei ist (verhindert „Übersicht frei, Buchung dann nicht verfügbar“).

## Backend (Git Repo)

### 1) Patch anwenden
Im Backend‑Repo (da wo `concierge-server.mjs` liegt):

```bash
git checkout -b feature/concierge-autobook
git apply patch_v37_autobook.diff
npm test || true
npm run start
```

Oder (falls du nicht mit `git apply` arbeiten willst):
- `concierge-server.mjs` durch `concierge-server_autobook_v37c.mjs` ersetzen (Datei umbenennen).

### 2) ENV Variablen setzen (Render)
Mindestens:
- `SMOOBU_API_KEY`
- `SMOOBU_CUSTOMER_ID`
- `OPENAI_API_KEY`
- `CONCIERGE_ENABLE_BOOKING_CHAT=true`
- `BOOKING_TOKEN_SECRET=<random long secret>`

Optional:
- `SMOOBU_CHANNEL_ID` (default 70)

### 3) Verhalten
- Der Concierge nennt **keine** anderen Buchungsplattformen (Hard‑Rule im OpenAI‑Systemprompt).
- Er bietet weiterhin `/buchen/` als **Fallback** an (Alpenlodge Booking Tool), aber primär wird im Chat gebucht.

## Frontend (nicht im Git)

### 1) JS austauschen
Ersetze deine aktuelle Concierge‑Datei durch:
- `al-concierge_autobook_v37.js` (umbenennen auf `al-concierge.js`)

oder update die Script‑Referenz entsprechend.

### 2) Was ist neu?
- Start‑Button **„Buchen“** ist jetzt ein Postback (bleibt im Chat).
- Links öffnen **immer** in einem neuen Tab (`_blank`).
- Backend kann `ui.fullscreen=true` senden → Panel schaltet in Fullscreen‑Modus (für Booking‑Wizard).

## Smoke Test (ohne echte Buchung)
1) Öffne Concierge, klicke „Buchen“
2) Gib Datum ein: `1.2.26 - 5.2.26`
3) Wähle Option `1`
4) Klicke „Jetzt buchen“
5) Bis Review gehen, aber **nicht** „Buchung bestätigen“, wenn du keine echte Buchung auslösen willst.
