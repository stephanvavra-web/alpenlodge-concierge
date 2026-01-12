import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const THIERSEE = { lat: 47.5860, lon: 12.1070 };

// Resolve paths for local files (ESM-safe)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ---------------- Verified knowledge (NO HALLUCINATIONS) ----------------
// The concierge must ONLY recommend items that exist in this file. If an item isn't here,
// answer with official directories (also in this file) and ask the user what they want.
const KNOWLEDGE_FILE = process.env.KNOWLEDGE_FILE || path.join(__dirname, "knowledge", "verified.json");
let _knowledgeCache = { ts: 0, mtimeMs: 0, value: null };

function loadKnowledge() {
  try {
    const p = path.isAbsolute(KNOWLEDGE_FILE) ? KNOWLEDGE_FILE : path.join(process.cwd(), KNOWLEDGE_FILE);
    const st = fs.statSync(p);
    if (_knowledgeCache.value && _knowledgeCache.mtimeMs === st.mtimeMs) return _knowledgeCache.value;
    const raw = fs.readFileSync(p, "utf8");
    const json = JSON.parse(raw);
    _knowledgeCache = { ts: Date.now(), mtimeMs: st.mtimeMs, value: json };
    return json;
  } catch (e) {
    return null;
  }
}
// Normalize knowledge formats.
// Supports either:
// A) { categories: { ski: [...], restaurants: [...], ... }, directories: [...] }
// B) { items: [...], sources: {...}, alpenlodge:{center:{lat,lon}}, meta:{rules:{default_radius_km}} }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalizeKnowledge(raw) {
  if (!raw || typeof raw !== "object") return null;
  // Already in expected shape
  if (raw.categories && typeof raw.categories === "object") {
    return {
      categories: raw.categories,
      directories: Array.isArray(raw.directories) ? raw.directories : [],
      alpenlodge: raw.alpenlodge || null,
      meta: raw.meta || {},
    };
  }

  const out = { categories: {}, directories: [], alpenlodge: raw.alpenlodge || null, meta: raw.meta || {} };

  // Directories from `sources`
  if (raw.sources && typeof raw.sources === "object") {
    for (const [key, v] of Object.entries(raw.sources)) {
      if (!v) continue;
      const label = v.label || key;
      const url = v.url || v.source;
      if (url) out.directories.push({ label, url, category: key });
    }
  }

  // Items -> categories
  const items = Array.isArray(raw.items) ? raw.items : [];
  const center = raw?.alpenlodge?.center || raw?.center || null;
  const centerLat = Number(center?.lat);
  const centerLon = Number(center?.lon);

  const push = (cat, it) => {
    if (!out.categories[cat]) out.categories[cat] = [];
    out.categories[cat].push(it);
  };

  const mapTypeToCat = (it) => {
    const type = String(it?.type || "").toLowerCase();
    const tags = Array.isArray(it?.tags) ? it.tags.map(t => String(t).toLowerCase()) : [];
    if (type.includes("ski")) return "ski";
    if (type === "restaurant" || type === "cafe" || type === "bar") return "restaurants";
    if (type === "pharmacy" || type === "doctor" || type === "medical") return "medical";
    if (type === "event" || type.includes("event")) return "events";
    if (type.includes("wellness") || type.includes("pool") || type.includes("lake")) return "lakes_pools_wellness";
    if (type.includes("hiking") || type.includes("trail") || type.includes("tour")) return "hiking";
    if (type.includes("rental") || type.includes("shop")) return "rental";
    if (tags.includes("bayern") || ["schliersee","spitzingsee","bayrischzell","tegernsee"].some(x=>tags.includes(x))) return "bayern_daytrips";
    return null;
  };

  for (const it0 of items) {
    if (!it0 || typeof it0 !== "object") continue;
    const it = { ...it0 };

    // Normalize url fields
    if (!it.url && it.website) it.url = it.website;
    if (!it.sourceUrl && it.source) it.sourceUrl = it.source;

    // Compute approx_km_road (air distance fallback) if we can
    const lat = Number(it.lat);
    const lon = Number(it.lon);
    if (Number.isFinite(centerLat) && Number.isFinite(centerLon) && Number.isFinite(lat) && Number.isFinite(lon)) {
      const km = haversineKm(centerLat, centerLon, lat, lon);
      if (!Number.isFinite(it.approx_km_road)) it.approx_km_road = Math.round(km * 10) / 10;
    }

    const cat = mapTypeToCat(it);
    if (cat) push(cat, it);
  }

  // Alpenlodge amenities -> category "alpenlodge"
  if (raw.alpenlodge) {
    const a = raw.alpenlodge;
    const amen = Array.isArray(a.amenities) ? a.amenities : [];
    if (amen.length) out.categories.alpenlodge = amen.map(x => ({
      name: x.name || x.title || "Ausstattung",
      summary: x.details || x.summary || "",
      url: x.url || null,
      sourceUrl: x.source || x.sourceUrl || null
    }));
  }

  return out;
}


// ---------------- Units mapping (Website <-> Smoobu IDs) ----------------
// Used for: nicer booking/availability replies (names, categories, detail links)
// Source of truth: /data/units.json (generated from Abgeglichen.xlsx / units list).
const UNITS_FILE = path.join(__dirname, "data", "units.json");
let _unitsCache = { mtimeMs: 0, value: null };

function loadUnits() {
  try {
    const st = fs.statSync(UNITS_FILE);
    if (_unitsCache.value && _unitsCache.mtimeMs === st.mtimeMs) return _unitsCache.value;
    const raw = fs.readFileSync(UNITS_FILE, "utf8");
    const json = JSON.parse(raw);
    const units = Array.isArray(json?.units) ? json.units : [];
    _unitsCache = { mtimeMs: st.mtimeMs, value: units };
    return units;
  } catch {
    _unitsCache = { mtimeMs: 0, value: [] };
    return [];
  }
}

function foldText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findUnitByApartmentId(apartmentId) {
  const id = Number(apartmentId);
  if (!Number.isFinite(id)) return null;
  const units = loadUnits();
  return units.find((u) => Number(u.smoobu_id) === id) || null;
}

function findUnitMentionInText(userText) {
  const t = foldText(userText);
  if (!t) return null;
  const units = loadUnits();
  // Prefer longest name first to avoid partial collisions.
  const byLen = [...units].sort((a, b) => foldText(b.name).length - foldText(a.name).length);
  return byLen.find((u) => t.includes(foldText(u.name))) || null;
}

function detectUnitCategoryFilter(userText) {
  const t = foldText(userText);
  if (!t) return null;
  if (t.includes("premium")) return "Premium";
  if (t.includes("suite") || t.includes("suiten")) return "Suite";
  if (t.includes("apartment") || t.includes("apartments")) return "Apartment";
  return null;
}



function norm(s) {
  return (s || "").toString().trim();
}

function lower(s) {
  return norm(s).toLowerCase();
}

// Normalize text for fuzzy keyword matching (handles typos like "skigebiten").
function normText(s) {
  return lower(s)
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Convert common user date formats to ISO (YYYY-MM-DD).
// Supported: YYYY-MM-DD, DD.MM.YYYY, D.M.YY, DD/MM/YY, DD-MM-YYYY, etc.
function toISODate(input) {
  const raw = norm(input);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const m = raw.match(/^(\d{1,2})[\.\/-](\d{1,2})[\.\/-](\d{2,4})$/);
  if (!m) return null;
  let d = Number(m[1]);
  let mo = Number(m[2]);
  let y = Number(m[3]);
  if (![d, mo, y].every(Number.isFinite)) return null;
  if (y < 100) y = (y <= 69) ? (2000 + y) : (1900 + y);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dd = String(d).padStart(2, "0");
  const mm = String(mo).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function detectCategory(userText) {
  const t = normText(userText);
  if (!t) return null;
  // Ski: allow partial stems to survive typos (skigebiet -> skigeb..., skigebiten).
  if (/(skigeb|ski\b|snowboard|piste|lift|skifahren|skilift)/i.test(t)) return "ski";
  if (/(schlitten|rodel|rodelbahn|sled|toboggan)/i.test(t)) return "rodel";
  if (/(badesee|see\b|baden|schwimmen|strand|badestrand)/i.test(t)) return "lakes";
  if (/(hallenbad|therme|wellness|spa|sauna|infrarot|pool)/i.test(t)) return "wellness_pools";
  if (/(arzt|aerzte|apotheke|notdienst|notruf|krankenhaus|doctor|pharmacy)/i.test(t)) return "medical";
  if (/(restaurant|essen|kulinar|gasthof|cafe|bar|fruehstueck)/i.test(t)) return "restaurants";
  if (/(event|events|veranstaltung|veranstaltungen|sportevent|sportevents|kalender|termin)/i.test(t)) return "events";
  if (/(wandern|wanderweg|hike|spazier|winterwander|schneeschuh|langlauf|trail)/i.test(t)) return "hiking";
  if (/(schliersee|spitzing|spitzingsee|bayerischzell|tegernsee)/i.test(t)) return "bayern_daytrips";
  if (/(ausstattung|alpenlodge|haus|apartment|suite|fitness|wasch|trockner|laundry)/i.test(t)) return "alpenlodge";
  return null;
}

function isListIntent(userText) {
  const t = normText(userText);
  return /(liste|list|tipps|empfehl|vorschl|was gibt|wo kann|ideen|top|beste|uebersicht|overview)/i.test(t);
}

// Keep minimal per-session state so the user can answer "2" after a numbered list.
const sessionState = new Map(); // sessionId -> { lastList: [{name, summary, url, sourceUrl, approx_km_road, type}], ts }
const SESSION_TTL_MS = 30 * 60 * 1000;

function getSession(sessionId) {
  if (!sessionId) return null;
  const s = sessionState.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_TTL_MS) {
    sessionState.delete(sessionId);
    return null;
  }
  return s;
}

function setLastList(sessionId, items) {
  if (!sessionId) return;
  const s = getSession(sessionId) || { ts: Date.now() };
  s.lastList = items || [];
  s.ts = Date.now();
  sessionState.set(sessionId, s);
}

function parseListSelection(text) {
  const t = normText(text);
  if (!t) return null;
  // Accept "2", "nr 2", "punkt 2", "a2" (common typo from earlier placeholder list)
  const m = t.match(/^(?:nr\s*)?(?:punkt\s*)?(?:eintrag\s*)?(?:a\s*)?(\d{1,2})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || "").trim());
}


// ---------------- Booking / Availability / Prices (Smoobu) ----------------

function isBookingIntent(userText) {
  const t = foldText(userText);
  if (!t) return false;

  // Strong signals
  if (/(verfuegb|verfug|verfugbar|availability|available|frei|buch|booking|reserve)/i.test(t)) return true;

  // Price queries for stays
  if (/(preis|preise|kosten|rate|rates|angebot|angebote|quote)/i.test(t)) return true;

  // Date patterns usually indicate a stay query
  if (/(20\d{2}-\d{2}-\d{2})/.test(t)) return true;
  if (/(\d{1,2})[\.\/-](\d{1,2})[\.\/-](\d{2,4})/.test(t)) return true;

  return false;
}

function extractDateRange(userText) {
  const raw = String(userText || "");
  const hits = [];
  const re = /(\d{4}-\d{2}-\d{2}|\d{1,2}[\.\/-]\d{1,2}[\.\/-]\d{2,4})/g;
  for (const m of raw.matchAll(re)) {
    const iso = toISODate(m[1]);
    if (iso) hits.push(iso);
  }
  if (hits.length >= 2) return { arrival: hits[0], departure: hits[1] };

  // Also support explicit keywords (anreise/abreise)
  const a = raw.match(/anreise[:\s]*([0-9\.\-\/]{6,12})/i);
  const d = raw.match(/abreise[:\s]*([0-9\.\-\/]{6,12})/i);
  const aIso = a ? toISODate(a[1]) : null;
  const dIso = d ? toISODate(d[1]) : null;
  return { arrival: aIso || null, departure: dIso || null };
}

function extractGuestCount(userText) {
  const t = foldText(userText);

  // Common German phrases
  if (/\bzu zweit\b/.test(t)) return 2;
  if (/\bzu dritt\b/.test(t)) return 3;
  if (/\bzu viert\b/.test(t)) return 4;

  // Numeric patterns
  const m =
    t.match(/(\d+)\s*(personen|person|gaeste|gaste|gaste|gaeste|pax|people|erwachsene|adults|kids|kinder)?\b/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 30) return n;
  }
  return null;
}

function isoToDE(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || "");
}

function nightsBetween(arrivalIso, departureIso) {
  try {
    const a = new Date(`${arrivalIso}T00:00:00Z`).getTime();
    const d = new Date(`${departureIso}T00:00:00Z`).getTime();
    const n = Math.round((d - a) / 86400000);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function formatMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "auf Anfrage";
  const cur = currency || "EUR";
  try {
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: cur }).format(n);
  } catch {
    return `${n.toFixed(2)} ${cur}`;
  }
}

async function fetchStayOptions({ arrival, departure, guests }) {
  if (!SMOOBU_CUSTOMER_ID) {
    const e = new Error("SMOOBU_CUSTOMER_ID missing");
    e.status = 500;
    throw e;
  }

  const payload = {
    arrivalDate: arrival,
    departureDate: departure,
    apartments: [],
    customerId: Number(SMOOBU_CUSTOMER_ID),
  };
  const g = Number(guests);
  if (Number.isFinite(g) && g > 0) payload.guests = g;

  const cacheKey = JSON.stringify(payload);
  const cached = availabilityCacheGet(cacheKey);
  if (cached) return cached;

  const data = await smoobuFetch("/booking/checkApartmentAvailability", {
    method: "POST",
    jsonBody: payload,
  });

  availabilityCacheSet(cacheKey, data);
  return data;
}

function buildStayOptionList(data, { guests, unitFilter, categoryFilter } = {}) {
  const available = Array.isArray(data?.availableApartments) ? data.availableApartments : [];
  const prices = data?.prices || {};
  const opts = [];

  for (const idRaw of available) {
    const id = Number(idRaw);
    if (!Number.isFinite(id)) continue;

    const unit = findUnitByApartmentId(id);
    if (unitFilter && unit && foldText(unit.name) !== foldText(unitFilter)) continue;
    if (categoryFilter && unit && unit.category !== categoryFilter) continue;

    // Respect max occupancy if we know it
    if (unit?.max_persons && Number.isFinite(Number(guests)) && Number(guests) > Number(unit.max_persons)) continue;

    const p = prices?.[idRaw] || prices?.[String(id)] || null;

    opts.push({
      apartmentId: id,
      name: unit?.name || `Apartment ${id}`,
      category: unit?.category || null,
      m2: unit?.m2 ?? null,
      max_persons: unit?.max_persons ?? null,
      details_url: unit?.details_url || null,
      book_url: unit?.book_url || `/buchen/?apartmentId=${id}`,
      price: p?.price ?? null,
      currency: p?.currency ?? null,
    });
  }

  opts.sort((a, b) => {
    const ap = Number(a.price);
    const bp = Number(b.price);
    const aOk = Number.isFinite(ap) && ap > 0;
    const bOk = Number.isFinite(bp) && bp > 0;
    if (aOk && bOk) return ap - bp;
    if (aOk) return -1;
    if (bOk) return 1;
    return String(a.name).localeCompare(String(b.name), "de");
  });

  return opts;
}

function bookingActionsForMissingGuests(locale) {
  const de = [
    { type: "postback", label: "2 Personen", message: "2 Personen", kind: "primary" },
    { type: "postback", label: "3 Personen", message: "3 Personen" },
    { type: "postback", label: "4 Personen", message: "4 Personen" },
    { type: "postback", label: "5 Personen", message: "5 Personen" },
    { type: "link", label: "Online buchen", url: "/buchen/", kind: "link" },
  ];
  const en = [
    { type: "postback", label: "2 guests", message: "2 guests", kind: "primary" },
    { type: "postback", label: "3 guests", message: "3 guests" },
    { type: "postback", label: "4 guests", message: "4 guests" },
    { type: "postback", label: "5 guests", message: "5 guests" },
    { type: "link", label: "Book online", url: "/buchen/", kind: "link" },
  ];
  return (String(locale || "").toLowerCase().startsWith("en")) ? en : de;
}

function bookingActionsForResults(opts, { showDetails = true } = {}) {
  const actions = [];
  const top = opts.slice(0, 4);
  for (const o of top) {
    actions.push({ type: "link", label: `Buchen: ${o.name}`, url: o.book_url, kind: "primary" });
    if (showDetails && o.details_url) actions.push({ type: "link", label: `Details: ${o.name}`, url: o.details_url });
  }
  actions.push({ type: "postback", label: "Andere Daten", message: "Andere Daten" });
  actions.push({ type: "link", label: "Alle Optionen im Buchungstool", url: "/buchen/" });
  return actions;
}

async function maybeHandleBookingChat(lastUser, sessionId, locale) {
  const t = String(lastUser || "").trim();
  if (!t) return null;

  const isIntent = isBookingIntent(t);
  const sess = sessionId ? (getSession(sessionId) || { ts: Date.now() }) : null;
  const booking = (sess && sess.booking) ? sess.booking : null;
  const hasContext = Boolean(booking && booking.inProgress);

  if (!isIntent && !hasContext) return null;

  // Session is recommended for a smooth flow (buttons / follow-ups).
  const s = sessionId ? (getSession(sessionId) || { ts: Date.now() }) : { ts: Date.now() };
  s.booking = s.booking || {};
  s.booking.inProgress = true;

  // Reset / start over
  if (/^(reset|neu|von vorne|andere daten|andere termine|start over)$/i.test(foldText(t))) {
    s.booking = { inProgress: true };
    s.ts = Date.now();
    if (sessionId) sessionState.set(sessionId, s);
    return {
      reply: "Alles klar. Nenne mir bitte **Anreise** und **Abreise** (YYYY-MM-DD) und die **Anzahl Personen**.",
      actions: bookingActionsForMissingGuests(locale),
      source: "smoobu",
    };
  }

  // Update draft with whatever we can extract
  const range = extractDateRange(t);
  if (range.arrival) s.booking.arrival = range.arrival;
  if (range.departure) s.booking.departure = range.departure;

  const guests = extractGuestCount(t);
  if (guests) s.booking.guests = guests;

  const unit = findUnitMentionInText(t);
  if (unit) s.booking.unitFilter = unit.name;

  const cat = detectUnitCategoryFilter(t);
  if (cat) s.booking.categoryFilter = cat;

  // Persist session
  s.ts = Date.now();
  if (sessionId) sessionState.set(sessionId, s);

  const arrival = s.booking.arrival || null;
  const departure = s.booking.departure || null;
  const g = s.booking.guests || null;

  if (!arrival || !departure) {
    return {
      reply:
        "Für die Verfügbarkeit/Preise brauche ich **Anreise** und **Abreise**.\n" +
        "Bitte im Format **YYYY-MM-DD** (z. B. **2026-02-01** bis **2026-02-05**).",
      actions: bookingActionsForMissingGuests(locale),
      source: "smoobu",
    };
  }

  if (!g) {
    const n = nightsBetween(arrival, departure);
    return {
      reply:
        `Danke! Zeitraum: **${isoToDE(arrival)}** bis **${isoToDE(departure)}**` +
        (n ? ` (**${n} Nächte**)` : "") +
        `.\nWie viele Personen seid ihr?`,
      actions: bookingActionsForMissingGuests(locale),
      source: "smoobu",
    };
  }

  // Fetch options from Smoobu
  const data = await fetchStayOptions({ arrival, departure, guests: g });
  const opts = buildStayOptionList(data, {
    guests: g,
    unitFilter: s.booking.unitFilter,
    categoryFilter: s.booking.categoryFilter,
  });

  const n = nightsBetween(arrival, departure);
  if (!opts.length) {
    return {
      reply:
        `Leider finde ich für **${isoToDE(arrival)}** bis **${isoToDE(departure)}**` +
        (n ? ` (${n} Nächte)` : "") +
        ` und **${g} Personen** keine freien Einheiten.` +
        `\nMöchtest du andere Daten prüfen?`,
      actions: [
        { type: "postback", label: "Andere Daten", message: "Andere Daten", kind: "primary" },
        { type: "link", label: "Online buchen (alle Optionen)", url: "/buchen/" },
      ],
      source: "smoobu",
    };
  }

  const header =
    `✅ Frei für **${isoToDE(arrival)}** bis **${isoToDE(departure)}**` +
    (n ? ` (${n} Nächte)` : "") +
    ` · **${g} Personen**` +
    (s.booking.categoryFilter ? ` · Filter: **${s.booking.categoryFilter}**` : "") +
    (s.booking.unitFilter ? ` · Wunsch: **${s.booking.unitFilter}**` : "") +
    `\n` +
    `Preis (gesamt) laut Smoobu:`;

  const lines = opts.slice(0, 6).map((o, i) => {
    const meta = [
      o.category ? o.category : null,
      (o.max_persons ? `max ${o.max_persons}` : null),
      (o.m2 ? `${o.m2} m²` : null),
    ].filter(Boolean).join(" · ");
    const money = formatMoney(o.price, o.currency);
    return `${i + 1}) **${o.name}**${meta ? ` (${meta})` : ""} – **${money}**`;
  });

  return {
    reply: [header, ...lines].join("\n"),
    actions: bookingActionsForResults(opts),
    source: "smoobu",
  };
}


function mdLink(label, url) {
  // The frontend renders clickable sources separately via `links`.
  // Keep the reply text clean and non-hallucinated.
  if (!url) return label;
  return `${label} ↗`;
}

function buildCategoryReply(cat, kRaw, radiusKm = 35, sessionId = "") {
  const k = normalizeKnowledge(kRaw);
  if (!k || !k.categories) return null;
  const cats = k.categories;
  const dirs = Array.isArray(k.directories) ? k.directories : [];
  // Category aliases (legacy detector -> unified knowledge schema)
  const catKey = ({ lakes: "lakes_pools_wellness", wellness_pools: "lakes_pools_wellness" }[cat] || cat);

  const within = (item) => {
    const d = item?.approx_km_road;
    if (typeof d !== "number") return true;
    return d <= radiusKm;
  };

  const title = {
    ski: "Skigebiete",
    rodel: "Rodeln & Schlitten",
    lakes: "Badeseen & Wasser",
    wellness_pools: "Wellness & Bäder",
    restaurants: "Restaurants & Kulinarik",
    hiking: "Wanderwege (Sommer/Winter)",
    events: "Veranstaltungen & Sportevents",
    medical: "Ärzte/Apotheke/Notruf",
    alpenlodge: "Alpenlodge – Ausstattung",
    bayern_daytrips: "Ausflüge Bayern",
  }[cat] || cat;

  const itemsAll = (cats[catKey] || []).filter(within);
  const items = itemsAll.slice(0, 12);

  // Pick a few relevant official directories (fallback/sources)
  const dirKeywords = {
    ski: ["ski", "piste", "schnee"],
    rodel: ["rodel", "schlitten"],
    lakes: ["baden", "see", "strand"],
    wellness_pools: ["wellness", "sauna", "hallen"],
    restaurants: ["gastro", "kulinar", "restaurant"],
    events: ["event", "veranst"],
    medical: ["notruf", "apothek"],
    hiking: ["tour", "aktiv"],
    bayern_daytrips: ["schliersee", "tegern"],
    alpenlodge: ["alpenlodge"],
  };
  const kws = dirKeywords[cat] || [];
  const pickedDirs = dirs.filter((d) => {
    const l = (d?.label || "").toLowerCase();
    return kws.some((kw) => l.includes(kw));
  });
  const extraDirs = (pickedDirs.length ? pickedDirs : dirs).slice(0, 6);

  const lines = [];
  lines.push(`**${title} (Radius ~${radiusKm} km)**`);
  if (cat === "events") {
    lines.push("Sag mir Monat/Datum und Sportart (z. B. Skirennen, Trailrun, Fußball), dann filtere ich aus den offiziellen Kalendern.");
  }

  if (!items.length) {
    // No item-level entries available: provide official directories as sources.
    lines.push("Hier sind die offiziellen Quellen (immer aktuell):");
  } else {
    // Remember the last list for follow-up answers like "2".
    setLastList(sessionId, items);
    items.forEach((it, idx) => {
      const dist = typeof it.approx_km_road === "number" ? ` (${it.approx_km_road.toFixed(1)} km)` : "";
      const note = it.summary ? ` — ${it.summary}` : "";
      const internal = (it.sourceUrl && String(it.sourceUrl).toUpperCase().startsWith("INTERNAL")) ? " — intern bestätigt" : "";
      lines.push(`${idx + 1}) ${it.name}${dist}${note}${internal}`);
    });
  }

  if (extraDirs.length) {
    lines.push("\n**Offizielle Quellen/Verzeichnisse:**");
    for (const d of extraDirs) lines.push(`- ${d.label}: ${d.url}`);
  }


  const links = [];

  const seen = new Set();
  const pushLink = (label, url) => {
    if (!url || !isHttpUrl(url)) return;
    const key = `${label}@@${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ label, url });
  };

  for (const it of items) {
    if (it.url) pushLink(it.name, it.url);
    if (it.sourceUrl && it.sourceUrl !== it.url && !String(it.sourceUrl).toUpperCase().startsWith("INTERNAL")) {
      pushLink(`${it.name} (Quelle)`, it.sourceUrl);
    }
  }

  // Only add directories as links when we had no items (fallback)
  if (!items.length) {
    for (const d of extraDirs) {
      if (d?.url) pushLink(d.label, d.url);
    }
  }

  return { reply: lines.join("\n"), links };
}

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
  if (!ADMIN_TOKEN) return false;
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

// Quick env/status visibility (no secrets). Useful for Render debugging.
app.get("/api/debug/vars", (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    openai: {
      apiKeySet: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || "gpt-5.2",
      fallback: process.env.OPENAI_MODEL_FALLBACK || "gpt-4.1-mini",
    },
    smoobu: {
      apiKeySet: Boolean(process.env.SMOOBU_API_KEY),
      customerId: process.env.SMOOBU_CUSTOMER_ID || "",
      channelId: process.env.SMOOBU_CHANNEL_ID || "",
      adminTokenSet: Boolean(process.env.ADMIN_TOKEN),
    },
    booking: {
      bookingTokenSecretSet: Boolean(process.env.BOOKING_TOKEN_SECRET),
      rateLimitPerMin: BOOKING_RATE_LIMIT_PER_MIN,
    },
  });
});

// Knowledge visibility (no PII). Helps verify that lists are actually loaded on Render.
app.get("/api/debug/knowledge", (req, res) => {
  const raw = loadKnowledge();
  const k = normalizeKnowledge(raw);
  if (!k) return res.status(500).json({ ok: false, error: "knowledge_not_loaded", path: KNOWLEDGE_FILE });
  const counts = {};
  for (const [cat, arr] of Object.entries(k.categories || {})) counts[cat] = Array.isArray(arr) ? arr.length : 0;
  res.json({
    ok: true,
    path: KNOWLEDGE_FILE,
    categories: counts,
    directories: Array.isArray(k.directories) ? k.directories.length : 0,
    hasAlpenlodge: Boolean(k.alpenlodge),
  });
});

// Version/debug info (helps confirm Render runs the latest deploy)
app.get("/api/debug/version", (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    node: process.version,
    render: {
      serviceId: process.env.RENDER_SERVICE_ID || null,
      gitCommit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    },
  });
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
    const aIso = toISODate(arrivalDate);
    const dIso = toISODate(departureDate);
    if (!aIso || !dIso) {
      return res.status(400).json({
        error: "arrivalDate and departureDate required",
        hint: "Use YYYY-MM-DD or e.g. 1.1.26 / 01.01.2026",
      });
    }

    const payload = {
      arrivalDate: aIso,
      departureDate: dIso,
      apartments: Array.isArray(apartments) ? apartments : [],
      customerId: Number(SMOOBU_CUSTOMER_ID),
    };
    const guestsNum = (guests === undefined || guests === null || guests === "") ? undefined : Number(guests);
    if (Number.isFinite(guestsNum) && guestsNum > 0) payload.guests = guestsNum;
    if (typeof discountCode === "string" && discountCode.trim()) payload.discountCode = discountCode.trim();

    const cacheKey = JSON.stringify(payload);
    const cached = availabilityCacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await smoobuFetch("/booking/checkApartmentAvailability", {
      method: "POST",
      jsonBody: payload,
    });

    availabilityCacheSet(cacheKey, data);

// Build short-lived offer tokens so the public "book" endpoint can be protected without exposing ADMIN_TOKEN.
let offers = [];
try {
  const exp = Date.now() + 10 * 60 * 1000; // 10 minutes
  const available = Array.isArray(data.availableApartments) ? data.availableApartments : [];
  offers = available
    .map((apartmentId) => {
      const priceInfo = data.prices?.[apartmentId] || null;
      const offerPayload = {
        apartmentId,
        arrivalDate: aIso,
        departureDate: dIso,
        guests: (Number.isFinite(guestsNum) && guestsNum > 0) ? guestsNum : null,
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
  const aIso = toISODate(arrivalDate);
  const dIso = toISODate(departureDate);
  if (!aIso || !dIso) {
    const err = new Error("Invalid date format");
    err.status = 400;
    err.details = { hint: "Use YYYY-MM-DD or e.g. 1.1.26 / 01.01.2026" };
    throw err;
  }

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
    arrivalDate: aIso,
    departureDate: dIso,
    guests: Number(guests),
  };

  const avail = await smoobuFetch("/booking/checkApartmentAvailability", {
    method: "POST",
    jsonBody: payload,
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
      arrivalDate: aIso,
      departureDate: dIso,
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
      arrival: offer.arrivalDate,
      departure: offer.departureDate,
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
    const result = await smoobuFetch("/api/reservations", {
      method: "POST",
      jsonBody: reservationPayload,
    });

    // Some Smoobu responses return {id:...} others {reservationId:...}
    const bookingId = result?.id ?? result?.reservationId ?? null;

    return res.status(200).json({
      ok: true,
      id: bookingId,
      offerUsed: {
        apartmentId: offer.apartmentId,
        arrival: offer.arrivalDate,
        departure: offer.departureDate,
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

    // Optional: stable per-widget session id (frontend can store it in localStorage)
    const sessionId =
      (typeof body.sessionId === "string" && body.sessionId) ||
      (typeof body.session === "string" && body.session) ||
      "";

    // Normalize user message
    const userMessage =
      (typeof body.message === "string" && body.message) ||
      (typeof body.question === "string" && body.question) ||
      "";

    let messages = Array.isArray(body.messages) ? body.messages : null;

    // Optional conversation history from the widget.
    // Expected: [{role:"user"|"assistant", content:"..."}, ...]
    const history = Array.isArray(body.history) ? body.history : null;

    if (!messages) {
      const sys = [
        "Du bist der Alpenlodge Concierge.",
        "Antworten kurz, freundlich und konkret.",
        "Wenn die Frage nach Verfügbarkeit/Preis klingt, frage nach: Anreise, Abreise, Anzahl Personen und (falls genannt) Wohnungsnummer.",
        "Wenn du Daten nicht hast, sag das ehrlich und biete an, es zu prüfen.",
        `Seite: ${page}. Locale: ${locale}.`,
      ].join(" ");

      const safeHist = (history || [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-12);

      messages = [{ role: "system", content: sys }, ...safeHist, { role: "user", content: userMessage || "Hallo" }];
    }

    // Quick weather path (keine OpenAI-Kosten, wenn eindeutig)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // If user replies with a number after a list (e.g. "2"), resolve it from session memory.
    const sel = parseListSelection(lastUser);
    if (sel && !sessionId) {
      return res.json({ reply: "Bitte frage zuerst nach einer Liste (z. B. **Skigebiete 35 km**) und antworte danach mit der Nummer (z. B. **2**).", source: "system" });
    }
    if (sel && sessionId) {
      const sess = getSession(sessionId);
      const list = sess?.lastList || [];
      const it = list[sel - 1];
      if (it) {
        const dist = typeof it.approx_km_road === "number" ? ` (${it.approx_km_road.toFixed(1)} km)` : "";
        const internal = (it.sourceUrl && String(it.sourceUrl).toUpperCase().startsWith("INTERNAL")) ? "intern bestätigt" : "";
        const replyLines = [
          `**${it.name}${dist}**`,
          it.summary ? it.summary : "",
          internal ? `(${internal})` : "",
        ].filter(Boolean);
        const links = [];
        if (it.url && isHttpUrl(it.url)) links.push({ label: it.name, url: it.url });
        if (it.sourceUrl && it.sourceUrl !== it.url && isHttpUrl(it.sourceUrl) && !String(it.sourceUrl).toUpperCase().startsWith("INTERNAL")) {
          links.push({ label: `${it.name} (Quelle)`, url: it.sourceUrl });
        }
        return res.json({ reply: replyLines.join("\n"), links, source: "knowledge" });
      }
    }

    

    // Booking / availability / prices (Smoobu) — deterministic, no hallucinations
    try {
      const booking = await maybeHandleBookingChat(lastUser, sessionId, locale);
      if (booking) return res.json(booking);
    } catch (err) {
      console.error("❌ Booking flow error:", err);
      const isEn = String(locale || "").toLowerCase().startsWith("en");
      return res.status(err.status || 500).json({
        reply: isEn
          ? "Sorry — I couldn't check availability/prices right now. Please try again in a moment."
          : "Sorry — ich konnte Verfügbarkeit/Preise gerade nicht prüfen. Bitte versuch es gleich nochmal.",
        error: "booking_error",
        details: err.details || null,
      });
    }

// Knowledge-first (NO hallucinations): lists/recommendations come from knowledge/verified.json
    // The widget can optionally send { radiusKm: 35 }.
    const radiusKmRaw = body.radiusKm ?? body.radius ?? body.distanceKm ?? body.distance;
    const radiusKm = Number.isFinite(Number(radiusKmRaw)) ? Number(radiusKmRaw) : 35;
    const cat = detectCategory(lastUser);
    if (cat) {
      const k = loadKnowledge();
      const mustAnswerFromKnowledge = Boolean(cat);
      if (mustAnswerFromKnowledge) {
        const r = buildCategoryReply(cat, k, radiusKm, sessionId);
        if (r?.reply) return res.json({ reply: r.reply, links: r.links || [], source: "knowledge" });
      }
    }

    if (isWeatherQuestion(lastUser)) {
      try {
        const w = await getWeatherTomorrow();
        return res.json({ reply: weatherText(w) });
      } catch (e) {
        return res.json({ reply: locale.startsWith("en") ? "I can't fetch live weather right now. Please try again." : "Ich kann das Live-Wetter gerade nicht abrufen. Bitte versuch es gleich nochmal." });
      }
    }

    // OpenAI (free text questions)
    // Defaults per requirement: high-end model with cheap fallback.
    const model = process.env.OPENAI_MODEL || "gpt-5.2";
    const fallbackModel = process.env.OPENAI_MODEL_FALLBACK || "gpt-4.1-mini";

    // Harden system instructions: never invent recommendations.
    const baseSys = messages.find(m => m.role === "system")?.content || "";
    const hardRules = [
      "WICHTIG: Erfinde niemals Orte, Restaurants, Events oder Dienstleistungen.",
      "Wenn du etwas nicht sicher weißt, verweise auf offizielle Verzeichnisse/Quellen und gib Links.",
      "Wenn der User nach Empfehlungen/Listen fragt: liefere sofort eine klare Liste aus dem verifizierten Knowledge (inkl. Links). Keine Rückfragen.",
    ].join(" ");
    const instructions = `${hardRules} ${baseSys}`.trim();
    const input = messages
      .filter(m => m.role !== "system")
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    let response;
    try {
      response = await openai.responses.create({
        model,
        instructions,
        input,
        temperature: 0.4,
      });
    } catch (e) {
      // automatic fallback
      if (fallbackModel && fallbackModel !== model) {
        response = await openai.responses.create({
          model: fallbackModel,
          instructions,
          input,
          temperature: 0.4,
        });
      } else {
        throw e;
      }
    }

    res.json({ reply: response?.output_text || "" });
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
// Public = nur read-only / safe. Alles andere nur mit ADMIN_TOKEN (Header: X-Admin-Token oder Authorization: Bearer ...)

function isPublicSmoobuAllowed(method, path) {
  if (method === "GET") {
    if (path === "/api/apartments" || path.startsWith("/api/apartments/")) return true;
    if (path.startsWith("/api/rates")) return true; // optional
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
      return res.status(403).json({ error: "forbidden", hint: "Set ADMIN_TOKEN in Render and send it as X-Admin-Token for write/admin Smoobu calls." });
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
  if (!forbidUnlessAdmin(req, res)) return;
  try {
    const data = await smoobuFetch("/api/reservations", { method: "GET", query: req.query });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu bookings list error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.get("/api/smoobu/bookings/:id", async (req, res) => {
  if (!forbidUnlessAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const data = await smoobuFetch(`/api/reservations/${encodeURIComponent(id)}`, { method: "GET", query: req.query });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu booking details error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

// Write endpoints (require ADMIN_TOKEN)
function forbidUnlessAdmin(req, res) {
  if (requireAdmin(req)) return true;
  res.status(403).json({ error: "forbidden", hint: "Missing/invalid ADMIN_TOKEN. Send header X-Admin-Token or Authorization: Bearer ..." });
  return false;
}

app.post("/api/smoobu/bookings", async (req, res) => {
  if (!forbidUnlessAdmin(req, res)) return;
  try {
    const data = await smoobuFetch("/api/reservations", { method: "POST", jsonBody: req.body || {} });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu create reservation error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.patch("/api/smoobu/bookings/:id", async (req, res) => {
  if (!forbidUnlessAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const data = await smoobuFetch(`/api/reservations/${encodeURIComponent(id)}`, { method: "POST", jsonBody: req.body || {} });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu update reservation error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.delete("/api/smoobu/bookings/:id", async (req, res) => {
  if (!forbidUnlessAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const data = await smoobuFetch(`/api/reservations/${encodeURIComponent(id)}/cancel`, { method: "POST", jsonBody: req.body || {} });
    res.json(data);
  } catch (err) {
    console.error("❌ Smoobu cancel reservation error:", err);
    res.status(err.status || 500).json({ error: "smoobu_error", details: err.details || null });
  }
});

app.post("/api/concierge", conciergeChatHandler);
// Alias from the API design doc
app.post("/concierge/chat", conciergeChatHandler);
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🤖 Concierge listening on ${PORT}`));