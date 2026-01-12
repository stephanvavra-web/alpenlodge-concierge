# PATCH v19 — Concierge: Listen/Empfehlungen bleiben + Smoobu-Buchung fix + SessionId fürs „2 / a2“

## Was wurde gefixt (ohne Features „wegzuzaubern“)
1) **Listen/Empfehlungen funktionieren wieder zuverlässig**  
   - Das Backend kann bereits Listenselektionen („2“, „nr 2“, **„a2“**) aus der letzten Liste auflösen – **aber nur, wenn der Client eine `sessionId` sendet**.  
   - Der Website-Widget (`al-concierge.js`) sendet jetzt automatisch eine **persistente `sessionId`** (localStorage) + eine kurze `history`.

2) **Smoobu: POST-Requests hatten keinen JSON-Body** (kritisch)  
   - `smoobuFetch()` akzeptiert `jsonBody`, nicht `headers/body`.  
   - Dadurch waren einige POSTs faktisch „leer“ (u.a. in /concierge/book + computeOfferPayloads).
   - Jetzt senden alle relevanten Stellen sauber `jsonBody`.

3) **Smoobu: Datum normalisiert auf ISO (YYYY-MM-DD)**  
   - Availability + OfferTokens + Booking verwenden jetzt konsequent `aIso/dIso`.
   - Dadurch funktionieren Eingaben wie **„1.1.26“** trotzdem zuverlässig.

4) **/api/debug/vars: rateLimitPerMin**  
   - Anzeige war ein falscher Variablenname. Jetzt zeigt es korrekt `BOOKING_RATE_LIMIT_PER_MIN`.

## Dateien in diesem Patch
- `concierge-server.mjs` (Backend / Render Service)
- `al-concierge.js` (Website Widget / Frontend)

## Installation (kurz)
1. Ersetze im Repo die beiden Dateien durch die Versionen aus diesem ZIP.
2. `git add -A && git commit -m "Fix: sessionId for lists + Smoobu JSON body + ISO dates" && git push`
3. Render deployt automatisch (oder Manual Deploy).

## Quick-Test
### A) Listen/Selektion
1. Frag im Concierge: „Liste Skigebiete“  
2. Danach: „2“ oder „a2“  
✅ Jetzt muss er Details zum Eintrag 2 liefern (inkl. Quellenlinks), statt nach An-/Abreise zu fragen.

### B) Smoobu Availability (flexible Dates)
```bash
curl -sS -X POST https://alpenlodge-concierge.onrender.com/api/smoobu/availability \
  -H "Content-Type: application/json" \
  -d '{"arrivalDate":"1.1.26","departureDate":"3.1.26","guests":"2"}' | jq
```

### C) Booking (wenn BOOKING_TOKEN_SECRET gesetzt)
1) erst availability holen → offerToken verwenden  
2) dann /concierge/book mit offerToken + Gastdaten posten

— Ende.
