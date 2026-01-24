# Patch v31 – Knowledge als CONTEXT (ohne harte Regeln)

Ziel:
- Wissen laden (property/apartments/equipment/weather/verified)
- GPT bleibt frei (keine 'nur verified' Regeln)
- Optional: strict lists per env `CONCIERGE_KNOWLEDGE_MODE=force`

Einspielen:
1) Dateien kopieren/überschreiben:
   - concierge-server.mjs
   - knowledge/*.json

2) ENV (Render):
   - CONCIERGE_KNOWLEDGE_MODE=context   # off | context | force
   - OPENAI_TEMPERATURE=0.8             # optional

Deploy testen:
- GET /health
- POST /api/concierge  (freier Chat, aber nutzt Kontext)
