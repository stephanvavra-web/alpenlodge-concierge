# Asset Cleanup (einmalig) — ohne Löschen

## Ziel
- Große Dateien (Bilder/Filme) **werden nicht gelöscht**.
- Unreferenzierte Assets werden **verschoben** nach:
  `_unused_assets/<timestamp>/...`

## Tools
- `deploy_alpenlodge_v3.sh` (setzt safe rsync-Strategie ein)
- `move_orphan_assets.mjs` (scannt Referenzen und verschiebt Orphans)

## Ablauf (empfohlen)
1) Deploy Code + Assets (safe)
```bash
cd /Users/stephanvavra/uzip
chmod +x deploy_alpenlodge_v3.sh
SKIP_BACKEND=1 ./deploy_alpenlodge_v3.sh
```

2) Einmaliges Aufräumen (Dry Run)
```bash
CLEAN_ORPHAN_ASSETS=1 DRY_RUN_CLEANUP=1 SKIP_BACKEND=1 ./deploy_alpenlodge_v3.sh
```

3) Wenn Output plausibel ist: Cleanup wirklich durchführen
```bash
CLEAN_ORPHAN_ASSETS=1 SKIP_BACKEND=1 ./deploy_alpenlodge_v3.sh
```

## Restore (falls eine Datei doch gebraucht wird)
Im Zielverzeichnis:
```bash
cd /Users/stephanvavra/Desktop/webserver/alpenlodge
ls -la _unused_assets/
# Datei zurückkopieren:
cp "_unused_assets/<ts>/<pfad/zur/datei.jpg>" "<pfad/zur/datei.jpg>"
```

## Grenzen
Die Referenz-Erkennung ist Regex-basiert. Dynamische Pfade können übersehen werden.
Deshalb: wir verschieben nur, wir löschen nicht.
