# Patch v17 – Restore verified lists/logic (schema-compatible)

## What this fixes
If the concierge replies with placeholder lists like "Skigebiet A/B/C", it usually means the verified knowledge file was loaded but *not* in the schema the code expects.

This patch makes the server accept BOTH schemas:

1) Preferred:
   - knowledge/verified.json with `{ categories: {...}, directories:[...] }`

2) One-file/legacy:
   - `{ items:[...], sources:{...}, alpenlodge:{center:{lat,lon}} }`

The server normalizes to `{categories, directories}` at runtime.

## Added debug endpoint
- `GET /api/debug/knowledge` shows whether knowledge loaded, counts per category, and small samples (no secrets).

## Deploy
Replace `concierge-server.mjs`, commit, push, redeploy on Render.

Then verify:
- `curl -sS https://<service>/api/debug/knowledge | jq`
