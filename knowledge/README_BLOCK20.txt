ALPENLODGE – BLOCK(20) Paket (Begriffe 11–20)

Inhalt:
- alpenlodge_search_terms_block20.txt          -> die 10 Begriffe dieses Blocks
- alpenlodge_50km_scan_config_block20.json     -> Scan-Config nur mit diesen 10 Begriffen
- scan_overpass_50km.py                        -> OSM/Overpass Scanner (erstellt verifizierbare items[])
- validate_50km_json.py                         -> Validator für JSON-Regeln
- alpenlodge_verified_50km_template.json        -> leere Ziel-Vorlage (Schema)
- alpenlodge_search_terms_A-Z_100plus.txt       -> vollständige Keywordliste
- ALPENLODGE_WISSEN_VOLL_2026-01-12.txt         -> Projektwissen

Run (Beispiel):
  python3 scan_overpass_50km.py alpenlodge_50km_scan_config_block20.json

Output:
  alpenlodge_verified_50km_osm_dump.json

Validieren:
  python3 validate_50km_json.py alpenlodge_verified_50km_osm_dump.json
