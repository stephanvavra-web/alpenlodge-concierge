# Patch v30 – Concierge unrestricted GPT + Links open in new window

Changes:
- Backend (concierge-server.mjs)
  - Removes strict "verified-knowledge only" behavior by default.
  - Enables booking chat by default (set CONCIERGE_ENABLE_BOOKING_CHAT=false to disable).
  - Adds optional strict mode (CONCIERGE_STRICT_KNOWLEDGE=true) to re-enable knowledge-first lists.
  - Removes "never invent" hard rules in the system instructions (rulebook later).
  - Adds OPENAI_TEMPERATURE env support (default 0.7).

- Frontend (al-concierge.js)
  - All link-type quick actions now open in a new browser window/tab via window.open(..., "_blank", "noopener,noreferrer").

Apply:
- Copy the two files into your repo root (same paths) OR run:
  git apply patch_v30_unrestricted.diff
