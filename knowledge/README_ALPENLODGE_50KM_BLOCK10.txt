ALPENLODGE – 50km Wissenssammlung (BLOCK 10) – Tooling ZIP
Stand: 2026-01-12 (Europe/Vienna)

Enthaltene Dateien
1) alpenlodge_50km_scan_config.json
   - Scan-Konfiguration (Center-Koordinaten, Radius 50km, Kategorien, Keywords A–Z)

2) scan_overpass_50km.py
   - Scanner: zieht POIs aus OpenStreetMap via Overpass API
   - Output: alpenlodge_verified_50km_osm_dump.json (STRICT Schema)

3) alpenlodge_verified_50km_template.json
   - Leere Zielvorlage (STRICT Schema) für manuell kuratierte/verifizierte Einträge

4) validate_50km_json.py
   - Validator für STRICT Schema (URLs nur http(s), lat/lon, last_verified_at, Duplicate-IDs, etc.)

5) alpenlodge_search_terms_A-Z_100plus.txt
   - Keyword-Liste A–Z + Bonus (100+ Begriffe)

6) ALPENLODGE_WISSEN_VOLL_2026-01-12.txt
   - Konsolidiertes Projektwissen Alpenlodge

Voraussetzungen
- Python 3.9+ empfohlen
- Internetzugang erforderlich (Overpass API)

Scan ausführen (ein Befehl)
1) Im Terminal in den Ordner mit den Dateien wechseln
2) Dann:
   python3 scan_overpass_50km.py alpenlodge_50km_scan_config.json

Ergebnis
- Datei: alpenlodge_verified_50km_osm_dump.json
- Enthält items[] mit lat/lon, url=http(s), source=http(s), last_verified_at=heutiges Datum

Validierung (optional aber empfohlen)
- Prüfe eine JSON-Datei:
  python3 validate_50km_json.py <DATEI>.json

Hinweis zur Datenqualität
- OSM/Overpass liefert echte, verifizierbare POIs.
- 50 Treffer pro Keyword kann nicht garantiert werden (abhängig von OSM-Datenlage).
- Regeln: KEINE Erfindungen, INTERNAL:* niemals als URL verwenden.
