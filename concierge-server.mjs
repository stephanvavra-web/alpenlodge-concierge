import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

// Fallback center (used only if knowledge file missing)
const ALPENLODGE_FALLBACK_CENTER = { lat: 47.58848, lon: 12.03342 }; // Landl 37 (Alpenlodge)

// ---------------- Knowledge (single file) ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KNOWLEDGE_FILE = process.env.KNOWLEDGE_FILE || path.join(__dirname, "knowledge", "verified.json");

let KNOWLEDGE = null;

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadKnowledge() {
  KNOWLEDGE = safeReadJson(KNOWLEDGE_FILE);
  if (!KNOWLEDGE) {
    console.warn("⚠️  Knowledge file missing/unreadable:", KNOWLEDGE_FILE);
  }
}

loadKnowledge();

// ---------------- Smoobu (läuft komplett über Render – kein PHP nötig) ----------------
// API Docs: https://docs.smoobu.com/  (Auth-Header: Api-Key)
const SMOOBU_API_KEY = process.env.SMOOBU_API_KEY;
const SMOOBU_CUSTOMER_ID = process.env.SMOOBU_CUSTOMER_ID; // int (dein Smoobu User/Customer ID)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // set in Render for write/admin Smoobu routes
const BOOKING_TOKEN_SECRET = process.env.BOOKING_TOKEN_SECRET || ""; // random secret to sign short-lived booking offer tokens
const SMOOBU_CHANNEL_ID = Number(process.env.SMOOBU_CHANNEL_ID || "70"); // default: 70 = Homepage (see Smoobu Channels list)
const BOOKING_RATE_LIMIT_PER_MIN = Number(process.env.BOOKING_RATE_LIMIT_PER_MIN || "30");
const SMOOBU_BASE = "https://login.smoobu.com";

// Mini-Cache (damit wir Smoobu nicht spammen)
const cache = {
  apartments: { ts: 0, ttlMs: 5 * 60 * 1000, value: null },
  availability: new Map(), // key -> {ts, ttlMs, value}
};

// ---------------- Security helpers ----------------
// ---------------- Public booking offer tokens (anti-abuse + integrity) ----------------
// Flow: /concierge/availability returns short-lived offerToken per apartment.
//       /concierge/book consumes offerToken + guest details -> creates Smoobu reservation.
const bookingRate = new Map(); // ip -> {windowStartMs,count}

function rateLimit(req, res, next) {
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  const now = Date.now();
  const winMs = 60 * 1000;
  const bucket = bookingRate.get(ip) || { windowStartMs: now, count: 0 };
  if (now - bucket.windowStartMs >= winMs) {
    bucket.windowStartMs = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  bookingRate.set(ip, bucket);
  if (bucket.count > BOOKING_RATE_LIMIT_PER_MIN) {
    return res.status(429).json({ error: "rate_limited", hint: "Please try again in a minute." });
  }
  next();
}

function b64urlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}
function b64urlDecode(b64url) {
  return Buffer.from(b64url, "base64url").toString("utf8");
}

function signOffer(payloadObj) {
  if (!BOOKING_TOKEN_SECRET) throw new Error("Missing BOOKING_TOKEN_SECRET");
  const payload = JSON.stringify(payloadObj);
  const payloadB64 = b64urlEncode(payload);
  const sig = crypto.createHmac("sha256", BOOKING_TOKEN_SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifyOffer(token) {
  if (!BOOKING_TOKEN_SECRET) throw new Error("Missing BOOKING_TOKEN_SECRET");
  const parts = (token || "").split(".");
  if (parts.length !== 2) throw new Error("Bad offer token");
  const [payloadB64, sig] = parts;
  const expected = crypto.createHmac("sha256", BOOKING_TOKEN_SECRET).update(payloadB64).digest("base64url");
  if (sig.length !== expected.length) throw new Error("Invalid offer token");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error("Invalid offer token");
  const payload = JSON.parse(b64urlDecode(payloadB64));
  if (!payload || typeof payload !== "object") throw new Error("Invalid offer token payload");
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) throw new Error("Offer expired");
  return payload;
}

function getAuthToken(req) {
  const h = req.headers || {};
  const bearer = typeof h.authorization === "string" ? h.authorization : "";
  if (bearer.toLowerCase().startsWith("bearer ")) return bearer.slice(7).trim();
  const x = typeof h["x-admin-token"] === "string" ? h["x-admin-token"] : "";
  return (x || "").trim();
}

function requireAdmin(req) {
  // If ADMIN_TOKEN is NOT set, we don't block any Smoobu endpoints.
  // If it IS set, it acts as an optional gate for write/admin calls.
  if (!ADMIN_TOKEN) return true;
  return getAuthToken(req) === ADMIN_TOKEN;
}

function ensureSmoobuPath(p) {
  // Only allow Smoobu API paths we expect
  // Valid prefixes per Smoobu docs: /api/* and /booking/*
  if (typeof p !== "string") return null;
  if (!p.startsWith("/")) p = "/" + p;
  if (p.startsWith("/api/") || p.startsWith("/booking/")) return p;
  return null;
}


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

async function smoobuFetch(path, { method = "GET", jsonBody, query, timeoutMs = 15000 } = {}) {
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
    const url = new URL(`${SMOOBU_BASE}${path}`);
    if (query && typeof query === "object") {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, String(vv)));
        else url.searchParams.set(k, String(v));
      }
    }
    const r = await fetch(url.toString(), init);
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

// ----------------------
// Verified knowledge (NO hallucinations)
// ----------------------
const KNOWLEDGE_PATH =
  process.env.KNOWLEDGE_PATH || path.join(process.cwd(), "knowledge", "verified.json");

function loadVerifiedKnowledge() {
  try {
    const raw = fs.readFileSync(KNOWLEDGE_PATH, "utf-8");
    const data = JSON.parse(raw);
    return data;
  } catch (err) {
    console.warn("⚠️ Could not load knowledge file:", KNOWLEDGE_PATH, err?.message || err);
    return null;
  }
}

let VERIFIED = loadVerifiedKnowledge();

function reloadVerifiedKnowledgeIfRequested() {
  if (process.env.KNOWLEDGE_RELOAD === "1") VERIFIED = loadVerifiedKnowledge();
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLon / 2) ** 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function getDefaultCenter() {
  return (
    VERIFIED?.alpenlodge?.center ||
    VERIFIED?.meta?.center ||
    ALPENLODGE_FALLBACK_CENTER
  );
}

function getDefaultRadiusKm() {
  return VERIFIED?.meta?.rules?.default_radius_km ?? 35;
}

function pickLocaleFromAcceptLanguage(req) {
  const h = req.headers["accept-language"] || "";
  if (h.toLowerCase().includes("de")) return "de";
  if (h.toLowerCase().includes("en")) return "en";
  return "de";
}

function detectIntents(text) {
  const t = (text || "").toLowerCase();
  const intents = new Set();

  if (/(restaurant|essen|mittag|abend|wirtshaus|gasthof|café|cafe|bar|kulinar)/i.test(t)) intents.add("restaurants");
  if (/(ski|skigebiet|piste|snowboard|langlauf|lift|nachtskifahren)/i.test(t)) intents.add("ski_areas");
  if (/(verleih|mieten|ausleihen|schlitten|rodel|ski.*verleih|snowboard.*verleih)/i.test(t)) intents.add("rental");
  if (/(badesee|see|schwimm|hallenbad|therme|wellness|spa|sauna)/i.test(t)) intents.add("lakes_pools_wellness");
  if (/(event|veranstaltung|konzert|festival|rennen|sportevent|triathlon|marathon|radmarathon|koasa)/i.test(t)) intents.add("events");
  if (/(arzt|apotheke|notdienst|krankenhaus|rettung|112|144|141|1450)/i.test(t)) intents.add("doctors_pharmacies");
  if (/(familie|kinder|spielplatz|indoor|aktivität|aktivitaet|familien)/i.test(t)) intents.add("family_activities");
  if (/(wandern|wanderweg|tour|schneeschuh|winterwandern|rodelbahn|bergroute)/i.test(t)) intents.add("hiking");
  if (/(ausstattung|fitness|infrarot|sauna|waschmaschine|trockner)/i.test(t)) intents.add("alpenlodge_amenities");

  // If nothing matched, still keep general intent
  if (intents.size === 0) intents.add("general");
  return [...intents];
}

function getVerifiedContext(userText) {
  reloadVerifiedKnowledgeIfRequested();
  const intents = detectIntents(userText);

  const center = getDefaultCenter();
  let radiusKm = getDefaultRadiusKm();

  // If user explicitly asks for Kitzbühel, allow extended region results
  const wantsKitz = /kitzb(ü|ue)hel/i.test(userText || "");
  const allowExtended = wantsKitz;

  const allItems = Array.isArray(VERIFIED?.items) ? VERIFIED.items : [];
  const wantedTypes = new Set();

  if (intents.includes("restaurants")) wantedTypes.add("restaurant");
  if (intents.includes("ski_areas")) wantedTypes.add("ski_area");
  if (intents.includes("rental")) wantedTypes.add("rental");
  if (intents.includes("lakes_pools_wellness")) wantedTypes.add("lake_pool_wellness");
  if (intents.includes("events")) wantedTypes.add("event");
  if (intents.includes("doctors_pharmacies")) wantedTypes.add("health");
  if (intents.includes("family_activities")) wantedTypes.add("family_activity");
  if (intents.includes("hiking")) wantedTypes.add("trail");

  const filtered = [];
  for (const it of allItems) {
    if (wantedTypes.size && !wantedTypes.has(it.type)) continue;

    const hasGeo = typeof it.lat === "number" && typeof it.lon === "number";
    if (hasGeo) {
      const d = haversineKm(center, { lat: it.lat, lon: it.lon });
      if (d <= radiusKm || (allowExtended && it.tags?.includes("extended"))) {
        filtered.push({ ...it, distance_km: Math.round(d * 10) / 10 });
      }
    } else {
      // No geo: include only if it's explicitly tagged extended and user asked for it
      if (allowExtended && it.tags?.includes("extended")) filtered.push(it);
      // Otherwise skip, because we can't guarantee it's inside radius
    }
  }

  // Sources (fallback directories)
  const sources = VERIFIED?.sources || {};
  const pick = (k) => (sources[k] ? { key: k, ...sources[k] } : null);

  const fallbackSources = [];
  if (intents.includes("restaurants")) fallbackSources.push(pick("restaurants"));
  if (intents.includes("ski_areas")) fallbackSources.push(pick("ski_areas"));
  if (intents.includes("rental")) fallbackSources.push(pick("rental"));
  if (intents.includes("lakes_pools_wellness")) fallbackSources.push(pick("lakes_pools_wellness"));
  if (intents.includes("events")) fallbackSources.push(pick("events"));
  if (intents.includes("doctors_pharmacies")) fallbackSources.push(pick("doctors_pharmacies"));
  if (intents.includes("hiking")) fallbackSources.push(pick("hiking"));

  return {
    intents,
    center,
    radiusKm,
    allowExtended,
    items: filtered,
    fallbackSources: fallbackSources.filter(Boolean),
    alpenlodge: VERIFIED?.alpenlodge || null,
    rules: VERIFIED?.meta?.rules || { default_radius_km: radiusKm, never_invent: true, always_show_source: true },
  };
}

function formatVerifiedContextForPrompt(ctx) {
  const lines = [];
  lines.push(`- Default radius: ${ctx.radiusKm} km (from Alpenlodge center ${ctx.center.lat}, ${ctx.center.lon})`);
  if (ctx.allowExtended) lines.push(`- Extended region enabled (user explicitly asked, e.g. Kitzbühel).`);
  lines.push(`- Intents: ${ctx.intents.join(", ")}`);

  const sources = ctx.fallbackSources || [];
  if (sources.length) {
    lines.push("\nOFFICIAL SOURCES (use these if no verified items exist):");
    for (const s of sources) lines.push(`- ${s.label}: ${s.source}`);
  }

  if (ctx.alpenlodge?.amenities?.length) {
    lines.push("\nALPENLODGE AMENITIES (owner-confirmed):");
    for (const a of ctx.alpenlodge.amenities) {
      lines.push(`- ${a.name}: ${a.details} | Quelle: ${a.source}`);
    }
  }

  const items = ctx.items || [];
  if (items.length) {
    lines.push("\nVERIFIED ITEMS (ONLY these names may be recommended):");
    for (const it of items.slice(0, 25)) {
      const d = typeof it.distance_km === "number" ? ` (${it.distance_km} km)` : "";
      const extra = it.details ? ` – ${it.details}` : "";
      lines.push(`- ${it.name}${d}${extra} | Quelle: ${it.source}`);
    }
    if (items.length > 25) lines.push(`... (${items.length - 25} more verified items omitted for brevity)`);
  } else {
    lines.push("\nNo verified nearby items found for this request. Provide ONLY official source links (no invented names).");
  }

  return lines.join("\n");
}

function ensureSourcesInReply(replyText, ctx) {
  // If we delivered verified items or official sources, but reply misses "Quelle:", append sources block.
  const hasSourcesWord = /quelle\s*:/i.test(replyText || "");
  const hadAnyContext =
    (ctx?.items?.length || 0) > 0 || (ctx?.fallbackSources?.length || 0) > 0 || (ctx?.alpenlodge?.amenities?.length || 0) > 0;

  if (hadAnyContext && !hasSourcesWord) {
    const lines = [];
    lines.push(replyText.trim());
    lines.push("\n\nQuellen:");
    for (const s of ctx.fallbackSources || []) lines.push(`- ${s.label}: ${s.source}`);
    // Also add item sources if present (deduplicated)
    const set = new Set();
    for (const it of ctx.items || []) if (it.source) set.add(it.source);
    for (const src of set) lines.push(`- ${src}`);
    return lines.join("\n");
  }
  return replyText;
}

// Optional: serve the knowledge file for debugging (read-only)
app.get("/api/knowledge", (req, res) => {
  reloadVerifiedKnowledgeIfRequested();
  if (!VERIFIED) return res.status(404).json({ error: "knowledge_missing", path: KNOWLEDGE_PATH });
  res.json({ path: KNOWLEDGE_PATH, meta: VERIFIED.meta, alpenlodge: VERIFIED.alpenlodge, items_count: (VERIFIED.items || []).length, sources: VERIFIED.sources });
});

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

    // Build short-lived offer tokens so the public "book" endpoint can be protected without exposing secrets.
let offers = [];
try {
  const exp = Date.now() + 10 * 60 * 1000; // 10 minutes
  const available = Array.isArray(data.availableApartments) ? data.availableApartments : [];
  offers = available
    .map((apartmentId) => {
      const priceInfo = data.prices?.[apartmentId] || null;
      const offerPayload = {
        apartmentId,
        arrivalDate,
        departureDate,
        guests: Number(guests || 0) || null,
        price: priceInfo?.price ?? null,
        currency: priceInfo?.currency ?? null,
        exp,
      };
      const offerToken = signOffer(offerPayload);
      return {
        apartmentId,
        price: offerPayload.price,
        currency: offerPayload.currency,
        offerToken,
      };
    })
    .filter(Boolean);
} catch (e) {
  // If BOOKING_TOKEN_SECRET is missing we still return availability, just without booking offers.
  offers = [];
}

res.json({
  ...data,
  offers,
  offerTtlSeconds: 600,
  channelIdDefault: SMOOBU_CHANNEL_ID,
  bookingHint: offers.length ? "Use POST /concierge/book with offerToken + guest details." : "Set BOOKING_TOKEN_SECRET to enable booking offers.",
});
  } catch (err) {
    console.error("❌ Smoobu availability error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
}

app.post("/api/smoobu/availability", smoobuAvailabilityHandler);
// Aliases from the design doc / older frontend variants
app.post("/concierge/availability", rateLimit, smoobuAvailabilityHandler);
app.post("/api/availability", rateLimit, smoobuAvailabilityHandler);

// Compute fresh offer payloads directly from Smoobu (server-side).
// This lets /concierge/book work without the client having to pass an offerToken.
async function computeOfferPayloads(arrivalDate, departureDate, guests) {
  const customerIdRaw = process.env.SMOOBU_CUSTOMER_ID;
  if (!customerIdRaw) {
    const err = new Error("SMOOBU_CUSTOMER_ID is not set");
    err.status = 500;
    throw err;
  }
  const customerId = Number(customerIdRaw);
  if (!Number.isFinite(customerId)) {
    const err = new Error("SMOOBU_CUSTOMER_ID must be a number");
    err.status = 500;
    throw err;
  }

  const payload = {
    customerId,
    arrivalDate,
    departureDate,
    guests: Number(guests),
  };

  const avail = await smoobuFetch("/booking/checkApartmentAvailability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const availableApartments = Array.isArray(avail?.availableApartments) ? avail.availableApartments : [];
  const prices = avail?.prices || {};

  const offerPayloads = [];
  for (const id of availableApartments) {
    const key = String(id);
    const p = prices[key];
    if (!p) continue;
    offerPayloads.push({
      apartmentId: Number(id),
      arrivalDate,
      departureDate,
      guests: Number(guests),
      price: Number(p?.price ?? 0),
      currency: p?.currency || "EUR",
    });
  }
  return offerPayloads;
}

app.post("/concierge/book", rateLimit, async (req, res) => {
  try {
    const body = req.body || {};

    // --- Offer selection ---
    // Option A (recommended): client passes offerToken from /concierge/availability (signed + short-lived).
    // Option B: client passes (arrivalDate, departureDate, guests/adults+children, apartmentId optional) and we fetch a fresh offer from Smoobu.
    const offerToken = typeof body.offerToken === "string" ? body.offerToken.trim() : "";

    let offer = null;

    if (offerToken) {
      offer = verifyOffer(offerToken);
    } else {
      const arrivalDate = typeof body.arrivalDate === "string" ? body.arrivalDate.trim() : "";
      const departureDate = typeof body.departureDate === "string" ? body.departureDate.trim() : "";
      const adults = Number(body.adults ?? 0);
      const children = Number(body.children ?? 0);
      const guests = Number(body.guests ?? (adults + children));

      const apartmentId =
        body.apartmentId === undefined || body.apartmentId === null || body.apartmentId === ""
          ? null
          : Number(body.apartmentId);

      if (!arrivalDate || !departureDate || !Number.isFinite(guests) || guests <= 0) {
        return res.status(400).json({
          error: "missing_params",
          hint: "Provide offerToken OR (arrivalDate, departureDate, guests OR adults+children, apartmentId optional).",
        });
      }

      const offerPayloads = await computeOfferPayloads(arrivalDate, departureDate, guests);
      if (!offerPayloads.length) {
        return res.status(409).json({ error: "no_availability" });
      }

      if (apartmentId !== null && Number.isFinite(apartmentId)) {
        offer = offerPayloads.find((o) => o.apartmentId === apartmentId) || null;
        if (!offer) return res.status(409).json({ error: "apartment_not_available" });
      } else {
        // default: cheapest available apartment
        offer = [...offerPayloads].sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
      }
    }

    // Booking is only enabled if this secret exists (prevents the server from issuing offers/bookings by accident).
    if (!process.env.BOOKING_TOKEN_SECRET) {
      return res.status(500).json({
        error: "booking_disabled",
        hint: "Set BOOKING_TOKEN_SECRET in Render env (Environment Group) to enable booking.",
      });
    }

    // --- Guest details ---
    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const language = typeof body.language === "string" ? body.language.trim() : "de";
    const notice = typeof body.notice === "string" ? body.notice.trim() : "";

    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        error: "missing_guest_fields",
        hint: "Missing: firstName, lastName, email (phone optional).",
      });
    }

    const adults = Number(body.adults ?? offer.guests);
    const children = Number(body.children ?? 0);
    const guests = Number(body.guests ?? (adults + children) ?? offer.guests);

    // --- Build Smoobu reservation payload ---
    const reservationPayload = {
      // Smoobu expects YYYY-MM-DD
      arrivalDate: offer.arrivalDate,
      departureDate: offer.departureDate,
      apartmentId: offer.apartmentId,
      channelId: Number.isFinite(SMOOBU_CHANNEL_ID) ? SMOOBU_CHANNEL_ID : 70,

      // Guest data
      firstName,
      lastName,
      email,
      phone,
      language,

      // Guests
      adults: Number.isFinite(adults) ? adults : guests,
      children: Number.isFinite(children) ? children : 0,

      // Price (best effort; Smoobu may recalc)
      price: offer.price,
      currency: offer.currency,

      // Internal note (shows up for you, not the guest)
      notice,
    };

    // Create booking in Smoobu
    const result = await smoobuFetch("/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reservationPayload),
    });

    // Some Smoobu responses return {id:...} others {reservationId:...}
    const bookingId = result?.id ?? result?.reservationId ?? null;

    return res.status(200).json({
      ok: true,
      id: bookingId,
      offerUsed: {
        apartmentId: offer.apartmentId,
        arrivalDate: offer.arrivalDate,
        departureDate: offer.departureDate,
        guests: offer.guests,
        price: offer.price,
        currency: offer.currency,
      },
      result,
    });
  } catch (err) {
    console.error("❌ Smoobu booking error:", err);
    const status = err.status || 500;
    let details = err.details || null;
    if (!details) {
      details = { message: err?.message || String(err) };
    }
    res.status(status).json({ error: "booking_error", details });
  }
});

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

    // Helper: build a strict, source-first system prompt from the single knowledge file.
    function buildSystemPrompt(questionText) {
      const rules = KNOWLEDGE?.meta?.rules || {};
      const radiusKm = Number(rules.default_radius_km || 35);
      const center = KNOWLEDGE?.alpenlodge?.center || THIERSEE;

      const q = String(questionText || "").toLowerCase();
      const wantsEvents = /(event|events|veranstaltung|veranstaltungen|sportevent|sportevents|rennen|triathlon|marathon|lauf)/i.test(q);
      const wantsRestaurants = /(restaurant|essen|kulinarik|wirtshaus|gasthaus|pizza|burger|cafe|café)/i.test(q);
      const wantsSki = /(ski|skigebiet|snowboard|piste|lift|langlauf|rodel|schlitten)/i.test(q);
      const wantsLakesPools = /(badesee|see|baden|schwimmbad|hallenbad|therme|sauna|wellness)/i.test(q);
      const wantsHealth = /(arzt|ärzte|apotheke|notdienst|notruf|krankenhaus)/i.test(q);
      const wantsHiking = /(wandern|wanderweg|tour|hike|winterwandern|schneeschuh)/i.test(q);
      const wantsAmenities = /(ausstattung|amenities|fitness|sauna|wasch|trockner|wlan|wi-?fi|park|ladestation)/i.test(q);

      const sources = KNOWLEDGE?.sources || {};

      function pickSources() {
        const out = [];
        const add = (key) => {
          const s = sources[key];
          if (s?.source) out.push(`- ${s.label || key}: ${s.source}`);
        };
        if (wantsRestaurants) add("restaurants");
        if (wantsEvents) add("events");
        if (wantsSki) { add("ski_areas"); add("rental"); }
        if (wantsLakesPools) add("lakes_pools_wellness");
        if (wantsHealth) { add("doctors_pharmacies"); add("pharmacies"); }
        if (wantsHiking) add("hiking");
        if (out.length === 0) {
          // default set
          add("events");
          add("restaurants");
          add("hiking");
        }
        return out.join("\n");
      }

      function pickEventItems() {
        const items = Array.isArray(KNOWLEDGE?.items) ? KNOWLEDGE.items : [];
        const events = items.filter((it) => it && it.type === "event");
        // Prefer 2026 (if present)
        const e2026 = events.filter((e) => String(e.date_from || "").startsWith("2026"));
        const chosen = (e2026.length ? e2026 : events).slice(0, 12);
        if (!chosen.length) return "";
        return chosen
          .map((e) => {
            const d = e.date_from ? (e.date_to && e.date_to !== e.date_from ? `${e.date_from} bis ${e.date_to}` : e.date_from) : "";
            const where = e.location_name ? ` – ${e.location_name}` : "";
            return `- ${e.name}${where}${d ? ` (${d})` : ""} | Quelle: ${e.source}`;
          })
          .join("\n");
      }

      function pickAmenities() {
        const list = Array.isArray(KNOWLEDGE?.alpenlodge?.amenities) ? KNOWLEDGE.alpenlodge.amenities : [];
        if (!list.length) return "";
        return list
          .slice(0, 20)
          .map((a) => `- ${a.name}${a.details ? `: ${a.details}` : ""} | Quelle: ${a.source}`)
          .join("\n");
      }

      const blocks = [];
      if (wantsAmenities) {
        const a = pickAmenities();
        if (a) blocks.push(`Ausstattung Alpenlodge (verifiziert):\n${a}`);
      }
      if (wantsEvents) {
        const e = pickEventItems();
        if (e) blocks.push(`Sportevents/Veranstaltungen (verifiziert, Auswahl):\n${e}`);
      }

      const sourceBlock = pickSources();
      if (sourceBlock) blocks.push(`Offizielle Quellen (verwenden, wenn Details fehlen):\n${sourceBlock}`);

      const rulesBlock = [
        "Du bist der Alpenlodge Concierge.",
        "Regeln:",
        "- NIEMALS erfinden. Keine frei erfundenen Orts-/Restaurantnamen.",
        "- Empfehlungen sind erlaubt, aber IMMER mit Quelle (URL) pro Empfehlung/Eintrag.",
        "- Wenn du etwas nicht sicher aus verifiziertem Wissen beantworten kannst: gib statt einer Behauptung die passende OFFIZIELLE Quelle (URL). Sage NICHT 'kann ich nicht bestätigen'.",
        `- Standardradius: ${radiusKm} km ab Alpenlodge (Center: ${center.lat}, ${center.lon}).`,
        "- Kurz, freundlich, konkret."
      ].join("\n");

      return `${rulesBlock}\n\n${blocks.join("\n\n")}\n\nSeite: ${page}. Locale: ${locale}.`;
    }

    if (!messages) {
      const sys = buildSystemPrompt(userMessage);
      messages = [
        { role: "system", content: sys },
        { role: "user", content: userMessage || "Hallo" },
      ];
    } else {
      const lastUserFromClient = [...messages].reverse().find((m) => m.role === "user")?.content || userMessage || "";
      // If client provided its own system message, we still prepend our strict rules + sources.
      const existingSysIdx = messages.findIndex((m) => m.role === "system");
      const prepend = { role: "system", content: buildSystemPrompt(lastUserFromClient) };
      if (existingSysIdx >= 0) {
        messages[existingSysIdx] = { role: "system", content: `${prepend.content}\n\n---\n\n${messages[existingSysIdx].content || ""}` };
      } else {
        messages = [prepend, ...messages];
      }
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
    const modelPrimary = process.env.OPENAI_MODEL_PRIMARY || process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const modelFallback = process.env.OPENAI_MODEL_FALLBACK || (modelPrimary !== "gpt-4.1-mini" ? "gpt-4.1-mini" : "");
    const instructions = messages.find(m => m.role === "system")?.content || "";
    const input = messages
      .filter(m => m.role !== "system")
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    let response;
    try {
      response = await openai.responses.create({
        model: modelPrimary,
        instructions,
        input,
        temperature: 0.4,
      });
    } catch (e) {
      if (modelFallback) {
        response = await openai.responses.create({
          model: modelFallback,
          instructions,
          input,
          temperature: 0.4,
        });
      } else {
        throw e;
      }
    }

    res.json({ reply: response.output_text || "" });
  } catch (err) {
    console.error("❌ Concierge error:", err?.stack || err);
    const status = err?.status || err?.response?.status;
    const msg = err?.message || err?.response?.data?.error?.message || String(err);
    res.status(500).json({
      error: "backend_error",
      details: { status, message: msg },
      hint: "If chat fails: verify OPENAI_API_KEY + OPENAI_MODEL. If Smoobu fails: verify SMOOBU_API_KEY + SMOOBU_CUSTOMER_ID.",
    });
  }
}


// ---------------- Smoobu: "alles" verfügbar (generischer Proxy + Komfort-Endpunkte) ----------------
// Generic Smoobu proxy: supports ALL endpoints.
// If ADMIN_TOKEN is set, you can still gate write/admin calls by sending it.

function isPublicSmoobuAllowed(method, path) {
  if (method === "GET") {
    if (path === "/api/apartments" || path.startsWith("/api/apartments/")) return true;
    if (path.startsWith("/api/rates")) return true; // optional
    if (path === "/api/bookings" || path.startsWith("/api/bookings/")) return true; // read-only booking lookup
  }
  if (method === "POST" && path === "/booking/checkApartmentAvailability") return true;
  return false;
}

// Generic pass-through (supports ALL Smoobu endpoints)
// Example: GET  /api/smoobu/raw/api/apartments
//          POST /api/smoobu/raw/booking/checkApartmentAvailability
app.all("/api/smoobu/raw/:path(*)", async (req, res) => {
  try {
    const raw = req.params.path || "";
    const path = ensureSmoobuPath(raw);
    if (!path) return res.status(400).json({ error: "invalid_path", hint: "Path must start with /api/ or /booking/." });

    const method = (req.method || "GET").toUpperCase();
    const admin = requireAdmin(req);

    if (!admin && !isPublicSmoobuAllowed(method, path)) {
      return res.status(403).json({
        error: "forbidden",
        hint: "This instance is gated. Send ADMIN_TOKEN via X-Admin-Token or Authorization: Bearer ...",
      });
    }

    const jsonBody = (method === "GET" || method === "HEAD") ? undefined : (req.body || undefined);
    const data = await smoobuFetch(path, { method, jsonBody, query: req.query });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu raw proxy error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

// Komfort-Endpunkte (damit du nicht immer den /raw Weg nutzen musst)
app.get("/api/smoobu/rates", async (req, res) => {
  try {
    const data = await smoobuFetch("/api/rates", { method: "GET", query: req.query });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu rates error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.get("/api/smoobu/apartments/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await smoobuFetch(`/api/apartments/${encodeURIComponent(id)}`, { method: "GET", query: req.query });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu apartment details error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.get("/api/smoobu/bookings", async (req, res) => {
  try {
    const data = await smoobuFetch("/api/bookings", { method: "GET", query: req.query });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu bookings list error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.get("/api/smoobu/bookings/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const data = await smoobuFetch(`/api/bookings/${encodeURIComponent(id)}`, { method: "GET", query: req.query });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu booking details error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

// Write endpoints (if ADMIN_TOKEN is set, they are gated)
function forbidUnlessAdmin(req, res) {
  // If no ADMIN_TOKEN is set, do NOT block (default allow).
  if (!ADMIN_TOKEN) return false;
  if (requireAdmin(req)) return true;
  res.status(403).json({ error: "forbidden", hint: "Missing/invalid ADMIN_TOKEN." });
  return false;
}

app.post("/api/smoobu/bookings", async (req, res) => {
  if (!forbidUnlessAdmin(req, res)) return;
  try {
    const data = await smoobuFetch("/api/bookings", { method: "POST", jsonBody: req.body || {} });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu create booking error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.patch("/api/smoobu/bookings/:id", async (req, res) => {
  if (!forbidUnlessAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const data = await smoobuFetch(`/api/bookings/${encodeURIComponent(id)}`, { method: "PATCH", jsonBody: req.body || {} });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu update booking error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.delete("/api/smoobu/bookings/:id", async (req, res) => {
  if (!forbidUnlessAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const data = await smoobuFetch(`/api/bookings/${encodeURIComponent(id)}`, { method: "DELETE" });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu delete booking error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.post("/api/concierge", conciergeChatHandler);
// Alias from the API design doc
app.post("/concierge/chat", conciergeChatHandler);
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🤖 Concierge listening on ${PORT}`));