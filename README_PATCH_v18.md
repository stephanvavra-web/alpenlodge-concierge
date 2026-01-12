# Patch v18 – Restore verified lists & stop placeholder recommendations

## What it fixes
- Supports BOTH knowledge file formats:
  - Format A: {categories, directories}
  - Format B: {items, sources, alpenlodge, meta}
- Computes distances (air-distance fallback) when lat/lon exist and filters by radius.
- When there are no item-level entries, the reply shows only official sources (no fake A/B/C placeholders).
- Adds debug endpoints:
  - GET /api/debug/knowledge
  - GET /api/debug/version

## Install
1) Replace `concierge-server.mjs` with the patched file.
2) Commit + push to `main` (Render deploy branch).
3) Deploy on Render.

## Verify
- `curl -sS https://<service>.onrender.com/api/debug/knowledge | jq`
- Ask the widget: "liste mit skigebieten (35 km)"
