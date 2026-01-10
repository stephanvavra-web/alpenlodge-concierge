import express from "express";
import cors from "cors";
import OpenAI from "openai";
const THIERSEE = { lat: 47.5860, lon: 12.1070 };

// ---------------- Smoobu (läuft komplett über Render – kein PHP nötig) ----------------
// API Docs: https://docs.smoobu.com/  (Auth-Header: Api-Key)
const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;
const SMOOBU_CUSTOMER_ID = process.env.SMOOBU_CUSTOMER_ID; // int (dein Smoobu User/Customer ID)
const SMOOBU_BASE = "https://login.smoobu.com";

// Mini-Cache (damit wir Smoobu nicht spammen)
const cache = {
  apartments: { ts: 0, ttlMs: 5 * 60 * 1000, value: null },
  availability: new Map(), // key -> {ts, ttlMs, value}
};

function now() { return Date.now(); }

function cacheGet(entry) {
  if (!entry?.value) return null;
  if (now() - entry.ts > entry.ttlMs) return null;
  return entry.value;
}

function availabilityCacheGet(key) {
  const e = cache.availability.get(key);
  if (!e) return null;
  if (now() - e.ts > e.ttlMs) { cache.availability.delete(key); return null; }
  return e.value;
}

function availabilityCacheSet(key, value, ttlMs = 30 * 1000) {
  cache.availability.set(key, { ts: now(), ttlMs, value });
}

async function smoobuFetch(path, { method = "GET", jsonBody, timeoutMs = 15000 } = {}) {
  if (!SMOOBU_API_KEY) {
    const e = new Error("SMOOBU_API_KEY missing");
    e.status = 500;
    throw e;
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { "Api-Key": SMOOBU_API_KEY };
    const init = { method, headers, signal: controller.signal };
    if (jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(jsonBody);
    }
    const r = await fetch(`${SMOOBU_BASE}${path}`, init);
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!r.ok) {
      const e = new Error("Smoobu request failed");
      e.status = r.status;
      e.details = data;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function getWeatherTomorrow() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${THIERSEE.lat}&longitude=${THIERSEE.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
    `&timezone=Europe%2FVienna`;

  const r = await fetch(url);
  if (!r.ok) throw new Error("weather fetch failed");
  const data = await r.json();

  // Morgen = Index 1 (0 = heute)
  const i = 1;
  return {
    date: data.daily.time[i],
    tmin: data.daily.temperature_2m_min[i],
    tmax: data.daily.temperature_2m_max[i],
    pop: data.daily.precipitation_probability_max[i],
    code: data.daily.weathercode[i],
  };
}

function weatherText(w) {
  // Minimal-Mapping – reicht für Concierge
  const map = {
    0: "klar",
    1: "überwiegend klar",
    2: "teils bewölkt",
    3: "bewölkt",
    45: "Nebel",
    48: "Nebel",
    51: "leichter Niesel",
    61: "leichter Regen",
    63: "Regen",
    65: "starker Regen",
    71: "leichter Schnee",
    73: "Schnee",
    75: "starker Schnee",
    80: "Regenschauer",
    81: "kräftige Schauer",
    82: "heftige Schauer",
    95: "Gewitter",
  };
  const desc = map[w.code] ?? `Wettercode ${w.code}`;
  return `Wetter morgen (Thiersee, ${w.date}): ${desc}. ` +
         `Min ${w.tmin}°C / Max ${w.tmax}°C. Regenwahrscheinlichkeit bis ${w.pop}%.`;
}

function isWeatherQuestion(text = "") {
  const t = text.toLowerCase();
  return /(wetter|forecast|weather|regen|schnee|temperatur|sonnig|bewölkt)/.test(t);
}
const app = express();
app.use(cors());
app.use(express.json());

// ✅ Only ENV key (Render → Environment Variables)
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ OPENAI_API_KEY is missing. Set it in Render → Environment.");
  process.exit(1);
}
const openai = new OpenAI({ apiKey });
// ✅ Health check for Render / monitoring
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---------------- Smoobu proxy endpoints (für Website/Concierge) ----------------
// 1) Apartments
async function smoobuApartmentsHandler(req, res) {
  try {
    const cached = cacheGet(cache.apartments);
    if (cached) return res.json(cached);

    const data = await smoobuFetch("/api/apartments", { method: "GET" });
    cache.apartments.ts = now();
    cache.apartments.value = data;
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu apartments error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
}

app.get("/api/smoobu/apartments", smoobuApartmentsHandler);
// Aliases from the design doc / older frontend variants
app.get("/concierge/apartments", smoobuApartmentsHandler);
app.get("/api/apartments", smoobuApartmentsHandler);

// 2) Availability + price (Smoobu Booking API)
// Request body (min): { arrivalDate: "YYYY-MM-DD", departureDate: "YYYY-MM-DD", apartments?: [1,2], guests?: 2, discountCode?: "..." }
async function smoobuAvailabilityHandler(req, res) {
  try {
    if (!SMOOBU_CUSTOMER_ID) {
      return res.status(500).json({ error: "SMOOBU_CUSTOMER_ID missing" });
    }

    const { arrivalDate, departureDate, apartments, guests, discountCode } = req.body || {};
    if (!arrivalDate || !departureDate) {
      return res.status(400).json({ error: "arrivalDate and departureDate required (YYYY-MM-DD)" });
    }

    const payload = {
      arrivalDate,
      departureDate,
      apartments: Array.isArray(apartments) ? apartments : [],
      customerId: Number(SMOOBU_CUSTOMER_ID),
    };
    if (typeof guests === "number") payload.guests = guests;
    if (typeof discountCode === "string" && discountCode.trim()) payload.discountCode = discountCode.trim();

    const cacheKey = JSON.stringify(payload);
    const cached = availabilityCacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await smoobuFetch("/booking/checkApartmentAvailability", {
      method: "POST",
      jsonBody: payload,
    });

    availabilityCacheSet(cacheKey, data);
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu availability error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
}

app.post("/api/smoobu/availability", smoobuAvailabilityHandler);
// Aliases from the design doc / older frontend variants
app.post("/concierge/availability", smoobuAvailabilityHandler);
app.post("/api/availability", smoobuAvailabilityHandler);

async function conciergeChatHandler(req, res) {
  try {
    // Accept 3 payload styles:
    // A) Legacy widget: { lang, question, page }
    // B) "Design doc": { sessionId, page, locale, message, context }
    // C) Raw OpenAI: { messages: [{role, content}, ...] }

    const body = req.body || {};

    const locale =
      (typeof body.locale === "string" && body.locale) ||
      (typeof body.lang === "string" && (body.lang === "de" ? "de-DE" : body.lang === "en" ? "en" : body.lang)) ||
      "de-DE";

    const page = (typeof body.page === "string" && body.page) || "start";

    // Normalize user message
    const userMessage =
      (typeof body.message === "string" && body.message) ||
      (typeof body.question === "string" && body.question) ||
      "";

    let messages = Array.isArray(body.messages) ? body.messages : null;

    if (!messages) {
      const sys = [
        "Du bist der Alpenlodge Concierge.",
        "Antworten kurz, freundlich und konkret.",
        "Wenn die Frage nach Verfügbarkeit/Preis klingt, frage nach: Anreise, Abreise, Anzahl Personen und (falls genannt) Wohnungsnummer.",
        "Wenn du Daten nicht hast, sag das ehrlich und biete an, es zu prüfen.",
        `Seite: ${page}. Locale: ${locale}.`,
      ].join(" ");

      messages = [
        { role: "system", content: sys },
        { role: "user", content: userMessage || "Hallo" },
      ];
    }

    // Quick weather path (keine OpenAI-Kosten, wenn eindeutig)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    if (isWeatherQuestion(lastUser)) {
      try {
        const w = await getWeatherTomorrow();
        return res.json({ reply: weatherText(w) });
      } catch (e) {
        return res.json({ reply: locale.startsWith("en") ? "I can't fetch live weather right now. Please try again." : "Ich kann das Live-Wetter gerade nicht abrufen. Bitte versuch es gleich nochmal." });
      }
    }

    // OpenAI
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages,
      temperature: 0.4,
    });

    res.json({ reply: completion.choices?.[0]?.message?.content || "" });
  } catch (err) {
    console.error("❌ Concierge error:", err?.stack || err);
    res.status(500).json({
      error: "backend error",
      hint: "Check Render logs + OPENAI_API_KEY, and for Smoobu routes set SMOOBU_API_KEY & SMOOBU_CUSTOMER_ID.",
    });
  }
}

app.post("/api/concierge", conciergeChatHandler);
// Alias from the API design doc
app.post("/concierge/chat", conciergeChatHandler);
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🤖 Concierge listening on ${PORT}`));