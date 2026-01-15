# Alpenlodge Concierge – Wissens-DB Setup (Kurz-Anleitung)
Stand: 2026-01-14

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

## 4) In Concierge Repo einhängen (WICHTIG: alle JSONs werden geladen)
- Kopiere **alle verifizierten Knowledge-JSONs** in den Repo-Ordner `knowledge/` (**Dateiname egal**).
  - Beispiele: `verified.json`, `verified_updated.json`, `kufsteinerland_verified.json`, `concierge_knowledge_de_verified.json`, ...
- Der Backend-Server lädt beim Start automatisch **alle `*.json`** aus `knowledge/`, **die wie Knowledge aussehen** (Schema wird erkannt).
  - Reine Tooling/Config-JSONs (Scan-Config, Templates, …) werden **ignoriert** und erscheinen unter `skipped` im Debug-Endpunkt.
- Deploy (Render / Node)
- Prüfen:
  - GET `/api/debug/knowledge` → `files[]` listet die tatsächlich geladenen Dateien + Category-Counts

### Optional: anderes Knowledge-Verzeichnis / Single-File
- `KNOWLEDGE_FILE` kann auf **einen Ordner** (recommended) oder **eine einzelne JSON-Datei** zeigen.
  - Wenn nicht gesetzt: Default ist `<repo>/knowledge` (Ordner).

Wichtig: Im Concierge-Reply niemals Quellen/URLs ausgeben – nur über `links[]` (Frontend zeigt „Infos & Links“).
