# Alpenlodge Concierge – Wissens-DB Setup (Kurz-Anleitung)
Stand: 2026-01-13

Du hast eine ALL-IN-ONE Datei (Blocks 10–180). Darin sind u.a. enthalten:
- Scan-Configs (Center/Radius/Kategorien)
- Overpass Scanner (Python)
- Validator (Python)
- Strict JSON Template

## 1) ALL-IN-ONE in echte Dateien "explodieren"
```bash
python3 extract_all_in_one.py alpenlodge_blocks10-180_ALL_IN_ONE.txt --out knowledge_tooling
```
Ergebnis: knowledge_tooling/ enthält alle einzelnen Dateien.

## 2) 50km OSM Scan laufen lassen (verifizierbare POIs)
Empfohlen: v2 Scanner (bessere type/tags, keine 'Quelle:' im summary)
```bash
cd knowledge_tooling
python3 ../scan_overpass_50km_v2.py alpenlodge_50km_scan_config.json
```
Output: alpenlodge_verified_50km_osm_dump.json

## 3) Validieren
```bash
python3 validate_50km_json.py alpenlodge_verified_50km_osm_dump.json
```

## 4) In Concierge Repo einhängen
- Kopiere die JSON in den Repo-Ordner `knowledge/`
- Danach Deploy
- Prüfen: GET /api/debug/knowledge (counts)

Wichtig: Im Concierge-Reply niemals Quellen/URLs ausgeben – nur über links[] (Frontend zeigt 'Infos & Links').
