import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import Stripe from "stripe";
import pg from "pg";

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
const BOOKING_TOOL_URL = process.env.BOOKING_TOOL_URL || "/pages/alle-unterkuenfte.html"; // frontend booking overview (avoid legacy /buchen)
const SMOOBU_CHANNEL_ID = Number(process.env.SMOOBU_CHANNEL_ID || "70"); // default: 70 = Homepage (see Smoobu Channels list)
const BOOKING_RATE_LIMIT_PER_MIN = Number(process.env.BOOKING_RATE_LIMIT_PER_MIN || "30");
const CONCIERGE_ENABLE_BOOKING_CHAT = String(process.env.CONCIERGE_ENABLE_BOOKING_CHAT || "").toLowerCase() === "true";
const SMOOBU_BASE = "https://login.smoobu.com";

// Mini-Cache (damit wir Smoobu nicht spammen)
const cache = {
  apartments: { ts: 0, ttlMs: 5 * 60 * 1000, value: null },
  availability: new Map(), // key -> {ts, ttlMs, value}
};
// ---------------- Chat Data Feed (snapshot cache) ----------------
const CHAT_SNAPSHOT_DAYS = Number(process.env.CHAT_SNAPSHOT_DAYS || "100");
const CHAT_SNAPSHOT_MAX_AGE_MS = Number(process.env.CHAT_SNAPSHOT_MAX_AGE_MS || String(6 * 60 * 60 * 1000)); // 6h fallback
const CHAT_SNAPSHOT_DEBOUNCE_MS = Number(process.env.CHAT_SNAPSHOT_DEBOUNCE_MS || "15000"); // 15s
const APP_BUILD = process.env.APP_BUILD || null;

let chatSnapshotCache = { ts: 0, value: null, lastError: null, inFlight: null, pending: false, _t: null };

function isoTodayVienna() {
  const d = new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna", year:"numeric", month:"2-digit", day:"2-digit" }).format(d); // YYYY-MM-DD
}

function addDaysIso(iso, days) {
  const m = String(iso||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const out = new Date(dt.getTime() + Number(days) * 86400000);
  const y = out.getUTCFullYear();
  const mo = String(out.getUTCMonth() + 1).padStart(2, "0");
  const da = String(out.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

async function fetchChatSnapshot(days = CHAT_SNAPSHOT_DAYS) {
  const today = isoTodayVienna();
  const end = addDaysIso(today, Number(days));
  if (!end) throw new Error("bad_end_date");

  const aptList = await smoobuFetch("/api/apartments", { method: "GET", timeoutMs: 25000 });
  const apartments = Array.isArray(aptList?.apartments) ? aptList.apartments : [];
  const ids = apartments.map(a => Number(a.id)).filter(n => Number.isFinite(n));

  const detailsById = {};
  for (const id of ids) {
    try {
      detailsById[String(id)] = await smoobuFetch(`/api/apartments/${id}`, { method: "GET", timeoutMs: 25000 });
    } catch {
      detailsById[String(id)] = null;
    }
  }

  const rates = await smoobuFetch("/api/rates", {
    method: "GET",
    timeoutMs: 45000,
    query: { start_date: today, end_date: end, "apartments[]": ids },
  });

  const data = rates?.data || {};
  const units = ids.map((id) => {
    const calObj = data[String(id)] || data[id] || {};
    const calendar = Object.entries(calObj).map(([date, v]) => ({
      date,
      available: v?.available ?? null,
      price: v?.price ?? null,
      min_length_of_stay: v?.min_length_of_stay ?? null,
    })).sort((a,b)=> String(a.date).localeCompare(String(b.date)));

    const base = apartments.find(a => Number(a.id) === id) || {};
    return {
      apartmentId: id,
      name: base.name || `Apartment ${id}`,
      details: detailsById[String(id)],
      calendar,
    };
  });

  return { ok: true, generatedAt: new Date().toISOString(), build: APP_BUILD, days: Number(days), units };
}

function scheduleChatSnapshotRefresh(reason = "event") {
  if (chatSnapshotCache._t) clearTimeout(chatSnapshotCache._t);
  chatSnapshotCache._t = setTimeout(async () => {
    if (chatSnapshotCache.inFlight) { chatSnapshotCache.pending = true; return; }
    try {
      chatSnapshotCache.inFlight = fetchChatSnapshot(CHAT_SNAPSHOT_DAYS);
      const val = await chatSnapshotCache.inFlight;
      chatSnapshotCache.value = val;
      chatSnapshotCache.ts = Date.now();
      chatSnapshotCache.lastError = null;
    } catch (e) {
      chatSnapshotCache.lastError = { reason, message: e?.message || String(e) };
    } finally {
      chatSnapshotCache.inFlight = null;
      if (chatSnapshotCache.pending) { chatSnapshotCache.pending = false; scheduleChatSnapshotRefresh("pending"); }
    }
  }, CHAT_SNAPSHOT_DEBOUNCE_MS);
}


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
function isValidDateYMD(y, m, d) {
  if (![y, m, d].every(Number.isFinite)) return false;
  if (y < 1900 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === (m - 1) && dt.getUTCDate() === d;
}

function ymdInTimeZone(date, tz = "Europe/Vienna") {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const y = Number(get("year"));
    const m = Number(get("month"));
    const d = Number(get("day"));
    if (!isValidDateYMD(y, m, d)) return null;
    return { y, m, d };
  } catch {
    // Fallback: local timezone (still OK for absolute dates)
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    if (!isValidDateYMD(y, m, d)) return null;
    return { y, m, d };
  }
}

// Convert common user date formats to ISO (YYYY-MM-DD).
// Supported:
// - YYYY-MM-DD / YYYY-M-D
// - DD.MM.YYYY / D.M.YY / DD/MM/YY / DD-MM-YYYY
// - DD.MM (year inferred: current or next year)
// - "heute", "morgen", "übermorgen" (+ EN: today/tomorrow)
// - "13 Jan 2026", "13 Januar 26" (DE/EN month names)
function toISODate(input) {
  const raw0 = norm(input);
  if (!raw0) return null;
  const raw = raw0.trim();

  const t = normText(raw);

  // Relative keywords
  if (/(^|\s)(heute|today)(\s|$)/i.test(t)) {
    const ymd = ymdInTimeZone(new Date(), "Europe/Vienna");
    if (!ymd) return null;
    return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
  }
  if (/(^|\s)(morgen|tomorrow)(\s|$)/i.test(t)) {
    const ymd = ymdInTimeZone(new Date(Date.now() + 86400000), "Europe/Vienna");
    if (!ymd) return null;
    return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
  }
  if (/(^|\s)(uebermorgen|übermorgen|day\s+after\s+tomorrow)(\s|$)/i.test(t)) {
    const ymd = ymdInTimeZone(new Date(Date.now() + 2 * 86400000), "Europe/Vienna");
    if (!ymd) return null;
    return `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
  }

  // ISO-like (allow single digits and / . as separators)
  let m = raw.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!isValidDateYMD(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // Numeric D.M.[YY[YY]] or D-M-[YY[YY]] etc (year optional)
  m = raw.match(/^(\d{1,2})[\.\/-](\d{1,2})(?:[\.\/-](\d{2,4}))?$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = m[3] !== undefined ? Number(m[3]) : NaN;

    // Year missing: infer (current year or next year if already passed)
    if (!Number.isFinite(y)) {
      const base = ymdInTimeZone(new Date(), "Europe/Vienna");
      if (!base) return null;
      y = base.y;
      if (isValidDateYMD(y, mo, d)) {
        const candidate = new Date(Date.UTC(y, mo - 1, d));
        const today = new Date(Date.UTC(base.y, base.m - 1, base.d));
        if (candidate.getTime() + 86400000 < today.getTime()) y = y + 1;
      }
    } else if (y < 100) {
      y = (y <= 69) ? (2000 + y) : (1900 + y);
    }

    if (!isValidDateYMD(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // Month names (DE/EN)
  const months = {
    jan: 1, januar: 1, jänner: 1, jaenner: 1, january: 1,
    feb: 2, februar: 2, february: 2,
    mar: 3, märz: 3, maerz: 3, mrz: 3, march: 3,
    apr: 4, april: 4,
    may: 5, mai: 5,
    jun: 6, juni: 6, june: 6,
    jul: 7, juli: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, okt: 10, oktober: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, dez: 12, dezember: 12, december: 12,
  };

  // e.g. "13 Jan 2026" or "13. Januar 26"
  m = t.match(/^(\d{1,2})\s*\.?\s*([a-zäöü]+)\s*(\d{2,4})?$/i);
  if (m) {
    const d = Number(m[1]);
    const key = String(m[2] || "").toLowerCase();
    const mo = months[key] || months[key.slice(0, 3)] || null;
    if (!mo) return null;

    let y;
    if (m[3] !== undefined && m[3] !== "") {
      y = Number(m[3]);
      if (y < 100) y = (y <= 69) ? (2000 + y) : (1900 + y);
    } else {
      const base = ymdInTimeZone(new Date(), "Europe/Vienna");
      if (!base) return null;
      y = base.y;
      if (isValidDateYMD(y, mo, d)) {
        const candidate = new Date(Date.UTC(y, mo - 1, d));
        const today = new Date(Date.UTC(base.y, base.m - 1, base.d));
        if (candidate.getTime() + 86400000 < today.getTime()) y = y + 1;
      }
    }

    if (!isValidDateYMD(y, mo, d)) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  return null;
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
function splitHttpUrls(value) {
  const s = String(value || "").trim();
  if (!s) return [];
  const parts = s.split(/\s*\|\s*/g).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (isHttpUrl(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

function pickFirstHttpUrl(...values) {
  for (const v of values) {
    const urls = splitHttpUrls(v);
    if (urls.length) return urls[0];
  }
  return null;
}

function stripUrlsFromText(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
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

function addDaysISO(iso, days) {
  try {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!isValidDateYMD(y, mo, d)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    const out = new Date(dt.getTime() + Number(days) * 86400000);
    const yy = out.getUTCFullYear();
    const mm = String(out.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(out.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  } catch {
    return null;
  }
}

function extractDateRange(userText) {
  const raw = String(userText || "");
  const hits = [];

  // Explicit keywords (anreise/abreise) first
  const a = raw.match(/anreise[:\s]*([^\s,;]+)/i);
  const d = raw.match(/abreise[:\s]*([^\s,;]+)/i);
  const aIso = a ? toISODate(a[1]) : null;
  const dIso = d ? toISODate(d[1]) : null;
  if (aIso || dIso) return { arrival: aIso || null, departure: dIso || null };

  // Numeric & ISO-like dates (year optional)
  const re = /(\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}|\d{1,2}[\.\/-]\d{1,2}(?:[\.\/-]\d{2,4})?)/g;
  for (const m of raw.matchAll(re)) {
    const iso = toISODate(m[1]);
    if (iso) hits.push(iso);
  }

  // Month-name forms like "13 Januar 26"
  const monthRe = /(\d{1,2}\s*\.?\s*[A-Za-zÄÖÜäöü]+(?:\s*\d{2,4})?)/g;
  for (const m of raw.matchAll(monthRe)) {
    const iso = toISODate(m[1]);
    if (iso) hits.push(iso);
  }

  // Relative words as candidates
  const relRe = /(heute|morgen|übermorgen|uebermorgen|today|tomorrow)/gi;
  for (const m of raw.matchAll(relRe)) {
    const iso = toISODate(m[1]);
    if (iso) hits.push(iso);
  }

  // De-dup while preserving order
  const uniq = [];
  const seen = new Set();
  for (const h of hits) {
    if (!h || seen.has(h)) continue;
    seen.add(h);
    uniq.push(h);
  }

  if (uniq.length >= 2) {
    let arrival = uniq[0];
    let departure = uniq[1];
    // If swapped, auto-fix
    if (arrival && departure && arrival > departure) {
      const tmp = arrival;
      arrival = departure;
      departure = tmp;
    }
    return { arrival, departure };
  }

  // One date + nights?
  if (uniq.length === 1) {
    const arrival = uniq[0];
    const t = foldText(raw);
    const m = t.match(/(\d{1,2})\s*(naechte|nächte|nachten|nights?)\b/);
    if (m) {
      const nights = Number(m[1]);
      if (Number.isFinite(nights) && nights > 0 && nights <= 30) {
        const departure = addDaysISO(arrival, nights);
        return { arrival, departure };
      }
    }
    return { arrival, departure: null };
  }

  return { arrival: null, departure: null };
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
      // Prefer explicit unit booking URL. If missing, fall back to details_url.
      // We avoid legacy "/buchen" paths because the site uses /pages/* for booking pages.
      book_url: (() => {
        let u = unit?.book_url || unit?.details_url || "";
        if (typeof u !== "string") u = "";
        // normalize legacy links
        if (u.startsWith("/buchen")) u = "";
        return u || BOOKING_TOOL_URL;
      })(),
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

function bookingCategoryActions(locale) {
  const isEn = String(locale || "").toLowerCase().startsWith("en");
  return isEn
    ? [
        { type: "postback", label: "Apartments", message: "Apartments" },
        { type: "postback", label: "Suites", message: "Suites" },
        { type: "postback", label: "Premium Suites", message: "Premium Suites" },
        { type: "postback", label: "All categories", message: "All categories" },
      ]
    : [
        { type: "postback", label: "Apartments", message: "Apartments" },
        { type: "postback", label: "Suiten", message: "Suiten" },
        { type: "postback", label: "Premium", message: "Premium Suiten" },
        { type: "postback", label: "Alle Kategorien", message: "Alle Kategorien" },
      ];
}

function bookingGuestCountActions(locale) {
  const isEn = String(locale || "").toLowerCase().startsWith("en");
  const nums = [1, 2, 3, 4, 5, 6];
  return nums.map((n) => ({
    type: "postback",
    label: isEn ? `${n} guests` : `${n} Personen`,
    message: isEn ? `${n} guests` : `${n} Personen`,
    kind: n === 2 ? "primary" : undefined,
  }));
}

function bookingActionsForNeedDates(locale) {
  const isEn = String(locale || "").toLowerCase().startsWith("en");
  return [
    ...bookingCategoryActions(locale),
    { type: "link", label: isEn ? "Open booking tool" : "Buchungstool öffnen", url: BOOKING_TOOL_URL, kind: "primary" },
  ];
}

function bookingActionsForResults(opts, locale) {
  const isEn = String(locale || "").toLowerCase().startsWith("en");
  const top = Array.isArray(opts) ? opts.slice(0, 4) : [];
  const actions = [];
  top.forEach((o, i) => {
    actions.push({
      type: "postback",
      label: `${i + 1}) ${o.name}`,
      message: String(i + 1),
      kind: i === 0 ? "primary" : undefined,
    });
  });
  actions.push({ type: "link", label: isEn ? "Open booking tool" : "Buchungstool öffnen", url: BOOKING_TOOL_URL });
  actions.push({ type: "postback", label: isEn ? "Other dates" : "Andere Daten", message: isEn ? "Other dates" : "Andere Daten" });
  actions.push(...bookingCategoryActions(locale));
  return actions;
}

function bookingActionsForSelectedUnit(selected, locale, { askGuests = false } = {}) {
  const isEn = String(locale || "").toLowerCase().startsWith("en");
  const actions = [];
  if (askGuests) actions.push(...bookingGuestCountActions(locale));
  if (selected?.book_url) {
    actions.push({
      type: "link",
      label: isEn ? "Book this" : "Diese Unterkunft buchen",
      url: selected.book_url,
      kind: "primary",
    });
  } else {
    actions.push({ type: "link", label: isEn ? "Open booking tool" : "Buchungstool öffnen", url: BOOKING_TOOL_URL, kind: "primary" });
  }
  actions.push({ type: "postback", label: isEn ? "Back to list" : "Zurück zur Liste", message: isEn ? "Back" : "Zurück" });
  actions.push({ type: "postback", label: isEn ? "Other dates" : "Andere Daten", message: isEn ? "Other dates" : "Andere Daten" });
  actions.push(...bookingCategoryActions(locale));
  return actions;
}

async function maybeHandleBookingChat(lastUser, sessionId, locale) {
  const t = String(lastUser || "").trim();
  if (!t) return null;

  const isIntent = isBookingIntent(t);
  const sess0 = sessionId ? (getSession(sessionId) || { ts: Date.now() }) : null;
  const hasContext = Boolean(sess0?.booking?.inProgress);

  if (!isIntent && !hasContext) return null;

  const isEn = String(locale || "").toLowerCase().startsWith("en");

  // Create or reuse session (if sessionId missing, we still do a one-shot answer)
  const s = sessionId ? (sess0 || { ts: Date.now() }) : { ts: Date.now() };
  s.booking = s.booking || {};
  s.booking.inProgress = true;

  // Basic navigation commands
  const tFold = foldText(t);
  const wantsReset = /^(reset|neu|von vorne|start over|other dates|andere daten|andere termine)/i.test(tFold);
  const wantsBack = /^(zuruck|zurueck|back|liste|list|uebersicht|overview)$/i.test(tFold);

  if (wantsReset) {
    const keepCat = s.booking.categoryFilter || null;
    s.booking = { inProgress: true, categoryFilter: keepCat };
    s.ts = Date.now();
    if (sessionId) sessionState.set(sessionId, s);
    return {
      reply: isEn
        ? "Tell me your **arrival** and **departure** date (e.g. **1.2.26 – 5.2.26**)."
        : "Nenne mir bitte **Anreise** und **Abreise** (z. B. **1.2.26 – 5.2.26**).",
      actions: bookingActionsForNeedDates(locale),
      source: "smoobu",
    };
  }

  if (wantsBack) {
    s.booking.unitFilter = null;
    s.booking.selectedApartmentId = null;
    s.ts = Date.now();
    if (sessionId) sessionState.set(sessionId, s);
    // fall through → show list (if dates exist)
  }

  // If user selects a number after we showed booking options, map it to that option (session only)
  const sel = parseListSelection(t);
  if (sel && Array.isArray(s.booking.lastOptions) && s.booking.lastOptions.length >= sel) {
    const picked = s.booking.lastOptions[sel - 1];
    if (picked) {
      s.booking.unitFilter = picked.name;
      s.booking.selectedApartmentId = picked.apartmentId;
    }
  }

  // Update booking state from user text
  const range = extractDateRange(t);
  if (range.arrival) s.booking.arrival = range.arrival;
  if (range.departure) s.booking.departure = range.departure;

  const g = extractGuestCount(t);
  if (g) s.booking.guests = g;

  // Category filter (optional)
  const cat = detectUnitCategoryFilter(t);
  if (cat) s.booking.categoryFilter = cat;

  if (/(^|\s)(alle\s+kategorien|all\s+categories|ohne\s+filter|no\s+filter|egal)(\s|$)/i.test(normText(t))) {
    s.booking.categoryFilter = null;
  }

  // Unit mention by name (works even without session)
  const unitMention = findUnitMentionInText(t);
  if (unitMention) {
    s.booking.unitFilter = unitMention.name;
    s.booking.selectedApartmentId = unitMention.smoobu_id;
  }

  // Persist session
  s.ts = Date.now();
  if (sessionId) sessionState.set(sessionId, s);

  const arrival = s.booking.arrival || null;
  const departure = s.booking.departure || null;

  if (!arrival || !departure) {
    const catLine = s.booking.categoryFilter
      ? (isEn ? `Category: **${s.booking.categoryFilter}**\n` : `Kategorie: **${s.booking.categoryFilter}**\n`)
      : "";
    return {
      reply: catLine + (isEn
        ? "Tell me your **arrival** and **departure** date (e.g. **1.2.26 – 5.2.26**)."
        : "Nenne mir bitte **Anreise** und **Abreise** (z. B. **1.2.26 – 5.2.26**)."),
      actions: bookingActionsForNeedDates(locale),
      source: "smoobu",
    };
  }

  // Pricing: If the guest count is unknown, we still show a *base* price for 1 guest (better UX than blocking).
  const pricingGuests = Number.isFinite(Number(s.booking.guests)) && Number(s.booking.guests) > 0 ? Number(s.booking.guests) : 1;
  const guestsKnown = Boolean(Number.isFinite(Number(s.booking.guests)) && Number(s.booking.guests) > 0);

  const data = await fetchStayOptions({ arrival, departure, guests: pricingGuests });

  const opts = buildStayOptionList(data, {
    arrival,
    departure,
    guests: pricingGuests,
    categoryFilter: s.booking.categoryFilter || null,
  });

  // Store last booking options for numeric selection ("2") in this session.
  if (sessionId) {
    s.booking.lastOptions = opts.slice(0, 10);
    s.ts = Date.now();
    sessionState.set(sessionId, s);
  }

  // If a unit was selected (by name or numeric selection), show a focused view.
  const selectedId = s.booking.selectedApartmentId ? Number(s.booking.selectedApartmentId) : null;
  const selectedNameFold = s.booking.unitFilter ? foldText(String(s.booking.unitFilter)) : "";
  const selected =
    (Number.isFinite(selectedId) && opts.find((o) => Number(o.apartmentId) === selectedId)) ||
    (selectedNameFold && opts.find((o) => foldText(o.name) === selectedNameFold)) ||
    null;

  if (selected) {
    const n = nightsBetween(arrival, departure);
    const meta = [
      selected.category || null,
      Number.isFinite(selected.max_persons) ? `max ${selected.max_persons}` : null,
      Number.isFinite(selected.m2) ? `${selected.m2} m²` : null,
    ].filter(Boolean).join(" · ");

    const money = formatMoney(selected.price, selected.currency);

    const lines = [];
    lines.push(`**${selected.name}**${meta ? ` (${meta})` : ""}`);
    lines.push(isEn
      ? `Dates: **${arrival}** → **${departure}**${n ? ` (${n} nights)` : ""}`
      : `Zeitraum: **${isoToDE(arrival)}** – **${isoToDE(departure)}**${n ? ` (${n} Nächte)` : ""}`);
    lines.push(guestsKnown
      ? (isEn ? `Price for **${pricingGuests} guests**: **${money}**` : `Preis für **${pricingGuests} Personen**: **${money}**`)
      : (isEn ? `Base price (1 guest): **${money}**` : `Basispreis (1 Person): **${money}**`));
    if (!guestsKnown) {
      lines.push(isEn
        ? "For the exact price, pick your group size:"
        : "Für den exakten Preis: wähle eure Personenzahl:");
    }

    return {
      reply: lines.join("\n"),
      actions: bookingActionsForSelectedUnit(selected, locale, { askGuests: !guestsKnown }),
      source: "smoobu",
    };
  }

  // No selection → show list
  const n = nightsBetween(arrival, departure);
  const headBits = [];
  headBits.push(isEn
    ? `✅ Availability: **${arrival}** → **${departure}**${n ? ` (${n} nights)` : ""}`
    : `✅ Frei: **${isoToDE(arrival)}** – **${isoToDE(departure)}**${n ? ` (${n} Nächte)` : ""}`);
  if (s.booking.categoryFilter) headBits.push(isEn ? `Category: **${s.booking.categoryFilter}**` : `Kategorie: **${s.booking.categoryFilter}**`);
  headBits.push(guestsKnown
    ? (isEn ? `Guests: **${pricingGuests}**` : `Personen: **${pricingGuests}**`)
    : (isEn ? "Price basis: **1 guest**" : "Preis-Basis: **1 Person**"));

  if (!opts.length) {
    return {
      reply: headBits.join(" · ") + "\n" + (isEn
        ? "Unfortunately nothing is available for that period. Try other dates."
        : "Leider ist für diesen Zeitraum nichts frei. Versuch bitte andere Daten."),
      actions: bookingActionsForNeedDates(locale),
      source: "smoobu",
    };
  }

  const lines = [];
  lines.push(headBits.join(" · "));
  lines.push(isEn ? "Pick an option:" : "Wähle eine Option:");

  opts.slice(0, 8).forEach((o, i) => {
    const meta = [o.category, Number.isFinite(o.max_persons) ? `max ${o.max_persons}` : null, Number.isFinite(o.m2) ? `${o.m2} m²` : null]
      .filter(Boolean)
      .join(" · ");
    const money = formatMoney(o.price, o.currency);
    lines.push(`${i + 1}) **${o.name}**${meta ? ` (${meta})` : ""} – **${money}**`);
  });

  if (opts.length > 8) {
    lines.push(isEn ? `(+${opts.length - 8} more)` : `(+${opts.length - 8} weitere)`);
  }

  return {
    reply: lines.join("\n"),
    actions: bookingActionsForResults(opts, locale),
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
  if (!k) return { reply: "Wissen ist gerade nicht geladen.", links: [] };

  const mapTitle = {
    skigebiete: "Skigebiete",
    restaurants: "Restaurants",
    lakes_pools_wellness: "Seen & Wellness",
    activities: "Aktivitäten",
    hikes: "Wanderungen",
    family: "Familie & Kids",
    shopping: "Shopping",
    nightlife: "Nightlife",
    events: "Events",
    alpenlodge: "Alpenlodge (Ausstattung & Hausinfos)",
  };
  const title = mapTitle[cat] || "Tipps";

  const isEvents = cat === "events";
  const itemsRaw = Array.isArray(k.categories?.[cat]) ? k.categories[cat] : [];
  const items = itemsRaw.filter((item) => {
    if (!item) return false;
    const d = item?.approx_km_road;
    if (typeof d === "number" && Number.isFinite(d) && d > radiusKm) return false;
    return true;
  });

  // Sort: events by start date; otherwise by distance if available
  const sorted = [...items].sort((a, b) => {
    if (isEvents) {
      const da = String(a?.date_start_iso || "");
      const db = String(b?.date_start_iso || "");
      if (da && db) return da.localeCompare(db);
      if (da) return -1;
      if (db) return 1;
      return 0;
    }
    const da = typeof a?.approx_km_road === "number" ? a.approx_km_road : Infinity;
    const db = typeof b?.approx_km_road === "number" ? b.approx_km_road : Infinity;
    return da - db;
  });

  const max = isEvents ? 10 : 12;
  const shown = sorted.slice(0, max);

  const lines = [];
  lines.push(`**${title}**`);

  if (isEvents) {
    lines.push("Wenn du mir Monat/Datum und Art (z. B. „Konzert“, „Markt“) sagst, filtere ich dir passende Termine.");
  }

  if (!shown.length) {
    lines.push("Dazu habe ich aktuell keine verifizierten Einträge in meiner Wissenssammlung.");
    lines.push("Im Block **Infos & Links** findest du passende Link‑Tipps.");
  } else {
    if (sessionId) {
      const sess = getSession(sessionId) || { ts: Date.now() };
      sess.lastList = shown;
      sess.ts = Date.now();
      sessionState.set(sessionId, sess);
    }

    shown.forEach((it, i) => {
      const dist = typeof it.approx_km_road === "number" ? ` (${it.approx_km_road.toFixed(1)} km)` : "";
      const internal = (it.sourceUrl && String(it.sourceUrl).toUpperCase().startsWith("INTERNAL")) ? " — intern bestätigt" : "";
      const sum = stripUrlsFromText(it.summary);
      lines.push(`${i + 1}) **${it.name}**${dist}${internal}`);
      if (sum) lines.push(`   ${sum}`);
    });

    if (sorted.length > shown.length) {
      lines.push(`… +${sorted.length - shown.length} weitere`);
    }
  }

  // Links: always in links[], never inline in reply.
  const links = [];
  const seen = new Set();
  const addLink = (label, url) => {
    if (!label || !isHttpUrl(url)) return;
    const u = String(url).trim();
    if (seen.has(u)) return;
    seen.add(u);
    links.push({ label: String(label), url: u });
  };

  if (shown.length) {
    for (const it of shown) {
      const u = pickFirstHttpUrl(it.url, it.sourceUrl);
      if (u) addLink(it.name, u);
    }
  } else {
    // Fallback: directory links for this category
    const dirs = Array.isArray(k.directories)
      ? k.directories.filter((d) => d && d.category === cat && isHttpUrl(d.url))
      : [];
    dirs.slice(0, 10).forEach((d) => addLink(d.label || "Link", d.url));
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
// Stripe webhooks require raw body; do NOT run express.json() on that route.
app.use("/api/payment/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ✅ Only ENV key (Render → Environment Variables)
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ OPENAI_API_KEY is missing. Set it in Render → Environment.");
  process.exit(1);
}
const openai = new OpenAI({ apiKey });
// ---------------- Stripe + DB (Pay -> Webhook -> Book) ----------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "eur").toLowerCase();

const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_SSL =
  String(process.env.DB_SSL || "").toLowerCase() === "true" ||
  String(process.env.PGSSLMODE || "").toLowerCase() === "require" ||
  /sslmode=require/i.test(DATABASE_URL);

const { Pool } = pg;
const db = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DB_SSL ? { rejectUnauthorized: false } : undefined,
      max: 5,
    })
  : null;

async function dbInit() {
  if (!db) return { ok: false, reason: "DATABASE_URL not set" };
  await db.query(`
    CREATE TABLE IF NOT EXISTS booking_payments (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL,
      stripe_payment_intent_id TEXT UNIQUE,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      offer_json JSONB NOT NULL,
      guest_json JSONB NOT NULL,
      extras_json JSONB NOT NULL,
      smoobu_reservation_id TEXT,
      last_error JSONB
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  return { ok: true };
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2022-11-15" }) : null;

async function dbUpsertStripeEvent(eventId, type) {
  if (!db) return false;
  await db.query(
    "INSERT INTO stripe_events(event_id, type) VALUES($1,$2) ON CONFLICT (event_id) DO NOTHING",
    [eventId, type]
  );
  const r = await db.query("SELECT event_id FROM stripe_events WHERE event_id=$1", [eventId]);
  return r.rowCount == 1;
}

function nightsBetweenIso(arrivalIso, departureIso) {
  try {
    const a = new Date(String(arrivalIso) + "T00:00:00Z").getTime();
    const d = new Date(String(departureIso) + "T00:00:00Z").getTime();
    const n = Math.round((d - a) / 86400000);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
function cents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}
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

// Public units list (safe subset). Used by the concierge booking wizard UI.
app.get("/api/units", (req, res) => {
  try {
    const units = loadUnits();
    const safe = (Array.isArray(units) ? units : []).map((u) => ({
      smoobu_id: u?.smoobu_id ?? u?.apartmentId ?? u?.apartment_id ?? null,
      name: u?.name ?? null,
      category: u?.category ?? null,
      max_persons: u?.max_persons ?? null,
      m2: u?.m2 ?? null,
      details_url: u?.details_url ?? null,
      book_url: u?.book_url ?? null,
    })).filter((u) => u.smoobu_id);
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      defaultBookingToolUrl: BOOKING_TOOL_URL,
      units: safe,
    });
  } catch (e) {
    console.error("❌ /api/units failed", e);
    res.status(500).json({ ok: false, error: "units_failed" });
  }
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

// ---------------- Debug: Chat snapshot ----------------
app.get("/api/debug/chat", (req, res) => {
  res.json({
    ok: true,
    hasSnapshot: Boolean(chatSnapshotCache.value),
    ts: chatSnapshotCache.ts || 0,
    ageMs: chatSnapshotCache.ts ? (Date.now() - chatSnapshotCache.ts) : null,
    lastError: chatSnapshotCache.lastError,
    inFlight: Boolean(chatSnapshotCache.inFlight),
  });
});

// ---------------- Chat Snapshot API ----------------
app.get("/api/chat/snapshot", async (req, res) => {
  try {
    const days = Number(req.query.days || CHAT_SNAPSHOT_DAYS);
    const fresh = chatSnapshotCache.value && chatSnapshotCache.ts && (Date.now() - chatSnapshotCache.ts) < CHAT_SNAPSHOT_MAX_AGE_MS;
    if (!fresh) {
      if (!chatSnapshotCache.inFlight) chatSnapshotCache.inFlight = fetchChatSnapshot(days);
      const val = await chatSnapshotCache.inFlight;
      chatSnapshotCache.value = val;
      chatSnapshotCache.ts = Date.now();
      chatSnapshotCache.lastError = null;
      chatSnapshotCache.inFlight = null;
    }
    res.json(chatSnapshotCache.value || { ok: false, error: "chat_snapshot_error" });
  } catch (e) {
    chatSnapshotCache.lastError = { message: e?.message || String(e) };
    res.status(500).json({ ok: false, error: "chat_snapshot_error", details: chatSnapshotCache.lastError });
  }
});

// Aliases for chat frontends
app.get("/chat/snapshot.json", (req, res) => {
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, "/api/chat/snapshot" + q);
});
app.get("/chat/snapshot", (req, res) => {
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, "/api/chat/snapshot" + q);
});

// Optional webhook trigger (Smoobu can POST events)
app.post("/api/smoobu/webhook", (req, res) => {
  scheduleChatSnapshotRefresh("smoobu_webhook");
  res.json({ ok: true });
});

// ---------------- Debug: DB status ----------------
app.get("/api/debug/db", async (req, res) => {
  try {
    if (!db) return res.json({ ok: true, kind: "memory", databaseUrlSet: false, ready: false });
    const r = await db.query("SELECT 1 as ok");
    res.json({ ok: true, kind: "postgres", databaseUrlSet: true, ready: r.rowCount === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, kind: "postgres", databaseUrlSet: Boolean(DATABASE_URL), ready: false, error: e?.message || String(e) });
  }
});

// ---------------- Stripe config (publishable key for frontend) ----------------
app.get("/api/payment/stripe/config", (req, res) => {
  res.json({
    ok: true,
    enabled: Boolean(STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY && STRIPE_WEBHOOK_SECRET && db),
    publishableKey: STRIPE_PUBLISHABLE_KEY || null,
    currency: STRIPE_CURRENCY,
  });
});

// ---------------- Stripe: Create PaymentIntent ----------------
app.post("/api/payment/stripe/create-intent", rateLimit, async (req, res) => {
  try {
    if (!stripe || !db) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

    const body = req.body || {};
    const offerToken = typeof body.offerToken === "string" ? body.offerToken.trim() : "";
    const discountCode = typeof body.discountCode === "string" ? body.discountCode.trim() : "";
    const src = typeof body.src === "string" ? body.src.trim() : "";
    if (!offerToken) return res.status(400).json({ ok: false, error: "missing_offerToken" });

    let offer;
    try { offer = verifyOffer(offerToken); }
    catch (e) { return res.status(400).json({ ok: false, error: "invalid_offerToken", message: e?.message || String(e) }); }

    const guest = (body.guest && typeof body.guest === "object") ? body.guest : {};
    const extras = (body.extras && typeof body.extras === "object") ? body.extras : {};

    const basePrice = Number(offer.price || 0);
    const nights = nightsBetweenIso(offer.arrivalDate, offer.departureDate);
    const dogs = Number(extras.dogs || 0);
    const dogPricePerNight = Number(extras.dogPricePerNight || 10);
    const dogExtra = (Number.isFinite(dogs) && dogs > 0 && Number.isFinite(dogPricePerNight) && dogPricePerNight > 0 && nights > 0)
      ? (dogs * dogPricePerNight * nights)
      : 0;

const ALLOW_COUPON = "last2026alp";
    const COUPON_PCT = 40;

    // Coupon is only valid when coming from the Lastminute landing page
    const isLastminuteSource = (/\/lpLM(?:de|en|nl)\//.test(src) || /\/lpLM(?:de|en|nl)\/index\.html$/.test(src) || ["/lpLMde/index.html","/lpLMen/index.html","/lpLMnl/index.html"].includes(src));

    const couponOk = (discountCode && discountCode === ALLOW_COUPON && isLastminuteSource);

    // Discount applies only to the accommodation base price (not extras like dogs)
    const discountBase = couponOk ? Math.max(0, basePrice) : 0;
    const discountAmount = couponOk ? (discountBase * (COUPON_PCT / 100)) : 0;
    const discountAmountCents = couponOk ? cents(discountAmount) : 0;

    const total = Math.max(0, basePrice + dogExtra - (discountAmountCents ? (discountAmountCents/100) : 0));
    const amountCents = cents(total);
    if (!amountCents) return res.status(400).json({ ok: false, error: "invalid_amount" });

    const paymentId = (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)));

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: STRIPE_CURRENCY,
      automatic_payment_methods: { enabled: true },
      metadata: { booking_payment_id: paymentId, discount_code: (couponOk ? discountCode : ''), discount_pct: (couponOk ? String(COUPON_PCT) : ''), src: (src || '') }
    });

    await db.query(
      "INSERT INTO booking_payments(id,status,stripe_payment_intent_id,amount_cents,currency,offer_json,guest_json,extras_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [paymentId, "intent_created", intent.id, amountCents, STRIPE_CURRENCY, JSON.stringify({"offer":offer,"offerToken":offerToken,"discount": (couponOk ? {code:discountCode,pct:COUPON_PCT,amountCents:discountAmountCents,src:src} : null)}), JSON.stringify(guest), JSON.stringify(extras)]
    );

    return res.json({ ok:true, paymentId, paymentIntentId:intent.id, clientSecret:intent.client_secret, amountCents, currency:STRIPE_CURRENCY });
  } catch (e) {
    console.error("❌ stripe create-intent error:", e);
    res.status(500).json({ ok:false, error:"stripe_error", details:{ message: e?.message || String(e)}});
  }
});

// ---------------- Stripe: Status ----------------
app.get("/api/payment/stripe/status/:paymentId", async (req, res) => {
  try {
    const id = String(req.params.paymentId || "").trim();
    if (!id) return res.status(400).json({ ok:false, error:"missing_paymentId" });
    if (!db) return res.status(500).json({ ok:false, error:"db_not_configured" });
    const r = await db.query("SELECT id,status,amount_cents,currency,stripe_payment_intent_id,smoobu_reservation_id,last_error,created_at FROM booking_payments WHERE id=$1", [id]);
    if (!r.rowCount) return res.status(404).json({ ok:false, error:"not_found" });
    return res.json({ ok: true, ...r.rows[0] });
  } catch(e) {
    res.status(500).json({ ok:false, error:"status_error", details: e?.message || String(e) });
  }
});


// ---- Post-payment calendar entry (Smoobu) — EXACT per API reference:
// POST /api/reservations with fields: apartmentId, arrival, departure, firstName, lastName, email, phone, channelId, adults, children, price.
// (We do NOT modify the existing booking flow; this is only used after payment.)
async function createReservationAfterPaymentExact({ offer, guest, extras, discountCode }) {
  
  // --- Dates (Smoobu reservations require arrival < departure)
  const arrival = String(offer?.arrivalDate || offer?.arrival || '').trim();
  const departure = String(offer?.departureDate || offer?.departure || '').trim();
  if (!arrival || !departure) {
    const err = new Error('missing_dates_for_reservation');
    err.details = { arrival, departure, offer };
    throw err;
  }
  if (departure <= arrival) {
    const err = new Error('invalid_reservation_dates');
    err.details = { arrival, departure, offer };
    throw err;
  }

const firstName = String(guest?.firstName || "").trim();
  const lastName  = String(guest?.lastName  || "").trim();
  const email     = String(guest?.email     || "").trim();
  const phone     = String(guest?.phone     || "").trim();
  const country   = String(guest?.country   || "").trim();
  const language  = String(guest?.language  || "de").trim();
  const addressObj = (guest?.address && typeof guest.address === "object") ? guest.address : {};
  const adults0 = Number(guest?.adults ?? offer?.guests ?? 0) || 0;
  const children0 = Number(guest?.children ?? 0) || 0;
  const guests0 = Number(offer?.guests ?? (adults0 + children0) ?? 0) || 0;

  const notice0 = String(guest?.notice || "").trim();
  const notice = (discountCode ? `${notice0} [DiscountCode:${String(discountCode).trim()}]`.trim() : notice0).slice(0,800);

  
}
// ---------------- Stripe: Webhook (PAYMENT -> BOOK) ----------------
app.post("/api/payment/stripe/webhook", async (req, res) => {
  try {
    if (!stripe || !db) return res.status(500).send("stripe_not_configured");
    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") return res.status(400).send("missing_signature");
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET); }
    catch (e) { return res.status(400).send("invalid_signature"); }

    const isNew = await dbUpsertStripeEvent(event.id, event.type);
    if (!isNew) return res.status(200).send("duplicate_event_ok");

    const type = event.type;
    const pi = event.data?.object;
    const paymentIntentId = String(pi?.id || "");
    const r0 = await db.query("SELECT * FROM booking_payments WHERE stripe_payment_intent_id=$1", [paymentIntentId]);
    if (!r0.rowCount) return res.status(200).send("unknown_intent_ok");
    const paymentId = r0.rows[0].id;

    if (type !== "payment_intent.succeeded") {
      await db.query("UPDATE booking_payments SET status=$2, last_error=$3 WHERE id=$1", [paymentId, "payment_failed", JSON.stringify({ type })]);
      return res.status(200).send("ok");
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query("SELECT * FROM booking_payments WHERE id=$1 FOR UPDATE", [paymentId]);
      const row = r.rows[0];
      if (row.status === "booked" && row.smoobu_reservation_id) { await client.query("COMMIT"); return res.status(200).send("already_booked_ok"); }

      await client.query("UPDATE booking_payments SET status=$2 WHERE id=$1", [paymentId, "paid"]);

      const offerWrap = JSON.parse(row.offer_json);
      const guest = JSON.parse(row.guest_json);
      const extras = JSON.parse(row.extras_json);

      const bookBody = {
        offerToken: offerWrap.offerToken,
        firstName: guest.firstName || "",
        lastName: guest.lastName || "",
        email: guest.email || "",
        phone: guest.phone || "",
        address: guest.address || {},
        country: guest.country || "",
        adults: Number(guest.adults || offerWrap.offer?.guests || 0) || 0,
        children: Number(guest.children || 0) || 0,
        language: guest.language || "de",
        notice: (guest.notice || "").toString().slice(0,800),
        extras,
      };

            // After successful payment: create reservation in Smoobu calendar (exact API payload).
      let outStatus = 200;
      let outJson = null;

      try {
        const offer = (offerWrap && offerWrap.offer) ? offerWrap.offer : verifyOffer(offerWrap.offerToken);
        outJson = await createReservationAfterPaymentExact({ offer, guest, extras, discountCode });
        outStatus = 200;
      } catch (e) {
        outStatus = e?.status || 500;
        outJson = { ok: false, error: (e?.message || String(e)), details: (e?.details || null) };
      }

if (outStatus !== 200 || !outJson || !outJson.ok) {
        await client.query("UPDATE booking_payments SET status=$2, last_error=$3 WHERE id=$1", [paymentId, "booking_failed", JSON.stringify({ outStatus, outJson })]);
        await client.query("COMMIT");
        return res.status(200).send("booking_failed_recorded");
      }

      const smoobuId = outJson.id ? String(outJson.id) : null;
      await client.query("UPDATE booking_payments SET status=$2, smoobu_reservation_id=$3 WHERE id=$1", [paymentId, "booked", smoobuId]);
      await client.query("COMMIT");
      return res.status(200).send("booked_ok");
    } catch (e) {
      await client.query("ROLLBACK");
      await db.query("UPDATE booking_payments SET status=$2, last_error=$3 WHERE id=$1", [paymentId, "booking_failed", JSON.stringify({ message: e?.message || String(e) })]);
      return res.status(200).send("booking_failed");
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("❌ stripe webhook error:", e);
    return res.status(500).send("webhook_error");
  }
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
    let aIso = toISODate(arrivalDate);
    let dIso = toISODate(departureDate);
    if (!aIso || !dIso) {
      return res.status(400).json({
        error: "arrivalDate and departureDate required",
        hint: "Use YYYY-MM-DD or e.g. 1.1.26 / 01.01.2026",
      });
    }

    // Defensive: ensure chronological order (prevents Smoobu validation errors when dates are swapped)
    if (aIso > dIso) {
      const tmp = aIso;
      aIso = dIso;
      dIso = tmp;
    }
    if (aIso === dIso) {
      return res.status(400).json({
        error: "invalid_date_range",
        hint: "departureDate must be after arrivalDate (mindestens 1 Nacht).",
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

// Dedicated Booking API (frontend <-> backend <-> Smoobu)
app.post("/api/booking/availability", rateLimit, smoobuAvailabilityHandler);

// Compute fresh offer payloads directly from Smoobu (server-side).
// This lets /concierge/book work without the client having to pass an offerToken.
async function computeOfferPayloads(arrivalDate, departureDate, guests, discountCode) {
  let aIso = toISODate(arrivalDate);
  let dIso = toISODate(departureDate);
  if (!aIso || !dIso) {
    const err = new Error("Invalid date format");
    err.status = 400;
    err.details = { hint: "Use YYYY-MM-DD or e.g. 1.1.26 / 01.01.2026" };
    throw err;
  }

  // Defensive: ensure chronological order (prevents swapped date ranges)
  if (aIso > dIso) {
    const tmp = aIso;
    aIso = dIso;
    dIso = tmp;
  }
  if (aIso === dIso) {
    const err = new Error("Invalid date range");
    err.status = 400;
    err.details = { error: "invalid_date_range", hint: "departureDate must be after arrivalDate (mindestens 1 Nacht)." };
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
    ...(discountCode ? { discountCode: String(discountCode).trim() } : {}),
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

async function publicBookHandler(req, res) {
  try {
    const body = req.body || {};

    // --- Offer selection ---
    // Option A (recommended): client passes offerToken from /concierge/availability (signed + short-lived).
    // Option B: client passes (arrivalDate, departureDate, guests/adults+children, apartmentId optional) and we fetch a fresh offer from Smoobu.
    const offerToken = typeof body.offerToken === "string" ? body.offerToken.trim() : "";
    const discountCode = typeof body.discountCode === "string" ? body.discountCode.trim() : "";
    const src = typeof body.src === "string" ? body.src.trim() : "";

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

      const offerPayloads = await computeOfferPayloads(arrivalDate, departureDate, guests, discountCode);
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
    // Some Smoobu setups (incl. booking tool validation settings) require
    // address/country/phone for direct bookings.
    //
    // IMPORTANT: In the Smoobu API, "address" is an object, not a string:
    //   address: { street, postalCode, location }, plus top-level "country".
    // We accept multiple input shapes for compatibility (frontend should send the object).
    const country = typeof body.country === "string" ? body.country.trim() : "";
    const language = typeof body.language === "string" ? body.language.trim() : "de";
    const notice = typeof body.notice === "string" ? body.notice.trim() : "";

    const addressObj = (() => {
      // Preferred: address as object
      if (body.address && typeof body.address === "object") {
        const street = typeof body.address.street === "string" ? body.address.street.trim() : "";
        const postalCode = typeof body.address.postalCode === "string" ? body.address.postalCode.trim() : "";
        const location = typeof body.address.location === "string" ? body.address.location.trim() : "";
        return { street, postalCode, location };
      }

      // Legacy: separate fields
      const street = typeof body.street === "string" ? body.street.trim() : "";
      const postalCode =
        typeof body.postalCode === "string"
          ? body.postalCode.trim()
          : typeof body.zip === "string"
            ? body.zip.trim()
            : "";
      const location =
        typeof body.location === "string"
          ? body.location.trim()
          : typeof body.city === "string"
            ? body.city.trim()
            : "";

      if (street || postalCode || location) {
        return { street, postalCode, location };
      }

      // Legacy: single line address string e.g. "Street 1, 6335 Thiersee"
      const line = typeof body.address === "string" ? body.address.trim() : "";
      if (!line) return { street: "", postalCode: "", location: "" };

      const parts = line
        .split(",")
        .map((p) => String(p || "").trim())
        .filter(Boolean);

      const street2 = parts[0] || line;
      const rest = parts.slice(1).join(" ").trim();

      let postal2 = "";
      let loc2 = "";

      if (rest) {
        const m = rest.match(/^(\d{3,10})\s+(.*)$/);
        if (m) {
          postal2 = m[1];
          loc2 = (m[2] || "").trim();
        } else {
          loc2 = rest;
        }
      }

      return { street: street2, postalCode: postal2, location: loc2 };
    })();

    // Guest validation (frontend should already enforce this, but keep backend strict).
    const missing = [];
    if (!firstName) missing.push("firstName");
    if (!lastName) missing.push("lastName");
    if (!email) missing.push("email");
    if (!phone) missing.push("phone");
    if (!addressObj.street) missing.push("address.street");
    if (!addressObj.postalCode) missing.push("address.postalCode");
    if (!addressObj.location) missing.push("address.location");
    if (!country) missing.push("country");

    if (missing.length) {
      return res.status(400).json({
        error: "missing_guest_fields",
        missing,
        hint: "Provide guest fields: firstName, lastName, email, phone, address{street,postalCode,location}, country.",
      });
    }

    const adults = Number(body.adults ?? offer.guests);
    const children = Number(body.children ?? 0);
    const guests = Number(body.guests ?? (adults + children) ?? offer.guests);

    // Defensive: normalize offer date order + format (prevents Smoobu validation errors)
    // We accept offer tokens from older versions too (arrival/departure vs arrivalDate/departureDate)
    if (offer) {
      const rawArrival = offer.arrivalDate ?? offer.arrival ?? "";
      const rawDeparture = offer.departureDate ?? offer.departure ?? "";

      let aIso = toISODate(rawArrival);
      let dIso = toISODate(rawDeparture);

      if (!aIso || !dIso) {
        return res.status(400).json({
          error: "invalid_date_format",
          hint: "arrival/departure must be YYYY-MM-DD (or a parseable date like 01.02.2026).",
          received: { arrival: rawArrival || null, departure: rawDeparture || null },
        });
      }

      if (aIso > dIso) {
        const tmp = aIso;
        aIso = dIso;
        dIso = tmp;
      }

      if (aIso === dIso) {
        return res.status(400).json({
          error: "invalid_date_range",
          hint: "departureDate must be after arrivalDate (mindestens 1 Nacht).",
        });
      }

      offer.arrivalDate = aIso;
      offer.departureDate = dIso;
    }

    // --- Build Smoobu reservation payload ---
    const reservationPayload = {
      // Smoobu API expects arrivalDate/departureDate (YYYY-MM-DD)
      // Docs: https://docs.smoobu.com/#create-booking
      arrivalDate: offer.arrivalDate,
      departureDate: offer.departureDate,
      apartmentId: offer.apartmentId,
      channelId: Number.isFinite(SMOOBU_CHANNEL_ID) ? SMOOBU_CHANNEL_ID : 70,

      // Guest data
      firstName,
      lastName,
      email,
      phone,
      address: addressObj,
      country,
      language,

      // Guests
      adults: Number.isFinite(adults) ? adults : guests,
      children: Number.isFinite(children) ? children : 0,

      // Price (best effort; Smoobu may recalc)
      price: offer.price,

      // Internal note (shows up for you, not the guest)
      notice: (discountCode ? `${notice || ''} [DiscountCode:${String(discountCode).trim()}]`.trim() : notice),
    };

    // Create booking in Smoobu
    const result = await smoobuFetch("/api/reservations", {
      method: "POST",
      jsonBody: reservationPayload,
    });

    // Some Smoobu responses return {id:...} others {reservationId:...}
    const bookingId = result?.id ?? result?.reservationId ?? null;

    // --- Optional extras (best effort) ---
    // Frontend may send extras like dogs; we attach them as price elements to the reservation.
    const extras = (body && typeof body.extras === 'object' && body.extras) ? body.extras : {};
    const extrasApplied = { dogs: 0, dogPricePerNight: 0, nights: 0, addedPriceElements: [], errors: [] };

    try {
      const dogs = Number(extras.dogs ?? 0);
      const dogPricePerNight = Number(extras.dogPricePerNight ?? 0);

      // nights between arrival and departure
      const nights = (() => {
        const a = new Date(String(offer.arrivalDate) + 'T00:00:00Z');
        const d = new Date(String(offer.departureDate) + 'T00:00:00Z');
        const ms = d.getTime() - a.getTime();
        const n = Math.round(ms / 86400000);
        return Number.isFinite(n) && n > 0 ? n : 0;
      })();

      extrasApplied.dogs = Number.isFinite(dogs) ? dogs : 0;
      extrasApplied.dogPricePerNight = Number.isFinite(dogPricePerNight) ? dogPricePerNight : 0;
      extrasApplied.nights = nights;

      if (bookingId && extrasApplied.dogs > 0 && extrasApplied.dogPricePerNight > 0 && nights > 0) {
        const amount = Math.round(extrasApplied.dogs * extrasApplied.dogPricePerNight * nights * 100) / 100;
        const pePayload = {
          name: `Hund (${extrasApplied.dogs}x)`,
          amount,
          tax: 0,
          calculationType: 0,
        };
        try {
          const peRes = await smoobuFetch(`/api/reservations/${encodeURIComponent(bookingId)}/price-elements`, {
            method: 'POST',
            jsonBody: pePayload,
          });
          extrasApplied.addedPriceElements.push({ type: 'dog', amount, response: peRes });
        } catch (e) {
          extrasApplied.errors.push({ type: 'dog', details: e?.details || { message: e?.message || String(e) } });
        }
      }
    } catch (e) {
      extrasApplied.errors.push({ type: 'extras', details: { message: e?.message || String(e) } });
    }

    scheduleChatSnapshotRefresh('booking');

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
      extrasApplied,
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
}

app.post("/concierge/book", rateLimit, publicBookHandler);
app.post("/api/booking/book", rateLimit, publicBookHandler);

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
        "Keine Buchung/Preise/Verfügbarkeit im Chat – nur Auskunft und Empfehlungen aus verifizierten Daten.",
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
      const bookingActive = Boolean(sess?.booking?.inProgress);
      if (!bookingActive) {
        const list = sess?.lastList || [];
        const it = list[sel - 1];
        if (it) {
          const dist = typeof it.approx_km_road === "number" ? ` (${it.approx_km_road.toFixed(1)} km)` : "";
          const internal = (it.sourceUrl && String(it.sourceUrl).toUpperCase().startsWith("INTERNAL")) ? "intern bestätigt" : "";
          const replyLines = [
            `**${it.name}${dist}**`,
            it.summary ? stripUrlsFromText(it.summary) : "",
            internal ? `(${internal})` : "",
          ].filter(Boolean);
          const links = [];
          const u = pickFirstHttpUrl(it.url, it.sourceUrl);
          if (u) links.push({ label: it.name, url: u });
          return res.json({ reply: replyLines.join("\n"), links, source: "knowledge" });
        }
      }
    }


    // Booking / availability / prices (Smoobu) — OPTIONAL.
    // Default: disabled (Concierge should be Auskunft only). Enable via env: CONCIERGE_ENABLE_BOOKING_CHAT=true
    if (CONCIERGE_ENABLE_BOOKING_CHAT) {
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
      "Wenn du etwas nicht sicher weißt, sag das ehrlich und biete passende Links an (falls vorhanden).",
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

(async () => {
  try {
    const r = await dbInit();
    if (r.ok) console.log("🗄️ DB ready");
    else console.log("🗄️ DB not used:", r.reason);
  } catch (e) {
    console.error("🗄️ DB init error:", e?.message || e);
  }
})();
app.listen(PORT, () => console.log(`🤖 Concierge listening on ${PORT}`));