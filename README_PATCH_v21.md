README_PATCH_v21_ZACK_LISTE_LINKS

Ziel
- Keine mehrstufigen Rückfragen bei Listen/Empfehlungen.
- "Zack: Liste" (aus verifiziertem Knowledge) + klickbare Links direkt in der Antwort.

Enthaltene Dateien
1) concierge-server.mjs
   - List-Antworten enthalten URLs inline (Link/Quelle)
   - Events: keine "Monat/Datum?" Rückfrage mehr, sondern Liste + offizielle Quellen
   - Category-Alias Fix: lakes + wellness_pools -> lakes_pools_wellness
   - Auswahl "2"/"a2": keine Rückfrage mehr; gibt Detail + Link/Quelle aus
   - Wenn jemand "2"/"a2" ohne SessionId sendet: kurzer Hinweis, wie es funktioniert

2) al-concierge.js
   - Sendet sessionId + kleine history ans Backend (damit "2"/"a2" zuverlässig klappt)
   - Linkify: alle http(s):// Links in Bot-Antworten sind klickbar

Installation
- Kopiere beide Dateien in dein Repo (gleiche Pfade/Dateinamen überschreiben):
  - ./concierge-server.mjs
  - ./al-concierge.js

Dann:
  git add concierge-server.mjs al-concierge.js
  git commit -m "Zack lists + clickable links"
  git push

Render
- Deploy abwarten (oder Manual Deploy klicken)

Schnelltests
1) Skigebiete:
   "liste mit skigebieten"  -> sofort Liste + Links inline
2) Restaurants:
   "restaurants" -> sofort Liste + Links inline
3) Seen/Wellness:
   "badesee" / "wellness" -> sofort Liste + Links inline
4) Auswahl:
   Nach einer Liste einfach "2" oder "a2" senden -> Detail + Link/Quelle (keine Rückfrage)

Hinweis
- Knowledge bleibt wie gehabt unter ./knowledge/*.json
- Keine Erfindungen: Listen kommen ausschließlich aus verified knowledge + offiziellen Verzeichnissen.
