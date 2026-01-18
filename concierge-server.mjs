import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import pg from "pg";
import Stripe from "stripe";

const THIERSEE = { lat: 47.5860, lon: 12.1070 };

// Helpful human-visible build marker (shows up in /api/debug/version and chat snapshot meta).
// You can override via Render env var APP_BUILD.
const APP_BUILD = process.env.APP_BUILD || "v53";

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

// Optional: protect your Smoobu webhook endpoint with a shared secret token.
// Configure your Smoobu webhook URL like: https://.../api/smoobu/webhook?token=YOUR_TOKEN
const SMOOBU_WEBHOOK_TOKEN = process.env.SMOOBU_WEBHOOK_TOKEN || "";

// ---------------- Chat Snapshot (chat.alpenlodge.info) ----------------
// Public, machine-readable availability + daily prices for the next N days.
// Used by voice agents / GPT actions to compute period prices deterministically.
const CHAT_SNAPSHOT_DAYS_DEFAULT = Number(process.env.CHAT_SNAPSHOT_DAYS || '100');
const CHAT_SNAPSHOT_REFRESH_MODE = String(process.env.CHAT_SNAPSHOT_REFRESH_MODE || 'webhook').toLowerCase();
const CHAT_SNAPSHOT_REFRESH_HOURS = Number(
  process.env.CHAT_SNAPSHOT_REFRESH_HOURS || (CHAT_SNAPSHOT_REFRESH_MODE === 'webhook' ? '24' : '3')
);
const CHAT_SNAPSHOT_TTL_MS = Math.max(1, CHAT_SNAPSHOT_REFRESH_HOURS) * 60 * 60 * 1000;
const CHAT_SNAPSHOT_APT_DETAILS_TTL_HOURS = Number(process.env.CHAT_SNAPSHOT_APT_DETAILS_TTL_HOURS || '24');
const CHAT_SNAPSHOT_APT_DETAILS_TTL_MS = Math.max(1, CHAT_SNAPSHOT_APT_DETAILS_TTL_HOURS) * 60 * 60 * 1000;

// Where to write the generated /chat/index.html + snapshot.json (default: /tmp).
// This makes the chat feed usable as a static file too (still served under the URL path /chat/...).
const CHAT_STATIC_DIR = process.env.CHAT_STATIC_DIR || path.join(os.tmpdir(), 'alpenlodge_chat');
const CHAT_STATIC_WRITE = String(process.env.CHAT_STATIC_WRITE || 'true').toLowerCase() !== 'false';
const CHAT_STATIC_SERVE = String(process.env.CHAT_STATIC_SERVE || 'true').toLowerCase() !== 'false';
let _chatStaticFiles = { ok: false, ts: 0, dir: CHAT_STATIC_DIR, error: null };

// Tracks the last Smoobu webhook we received (no secrets).
// Useful for debugging and to explain freshness in the chat feed.
const _smoobuWebhookState = { ts: 0, action: null, user: null };


// ---------------- Database (optional) ----------------
// Used to persist booking/payment state (needed for Stripe flow).
// If DATABASE_URL is missing or DB init fails, we fall back to in-memory storage (NOT recommended for production).
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL || "";
const BOOKING_QUOTE_TTL_MIN = Number(process.env.BOOKING_QUOTE_TTL_MIN || "15");
const BOOKING_QUOTE_TTL_MS = Math.max(1, BOOKING_QUOTE_TTL_MIN) * 60 * 1000;

// ---------------- Stripe (Payment Element) ----------------
// IMPORTANT: Use Render Environment Variables. Do NOT hardcode secrets.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_CURRENCY_DEFAULT = (process.env.STRIPE_CURRENCY || "eur").toLowerCase();

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Extras / pricing (server-side source of truth)
const DOG_PRICE_PER_NIGHT = Number(process.env.DOG_PRICE_PER_NIGHT || "10");
const DOG_PRICE_PER_NIGHT_CENTS = Number.isFinite(DOG_PRICE_PER_NIGHT)
  ? Math.round(DOG_PRICE_PER_NIGHT * 100)
  : 0;

const dbState = { kind: DATABASE_URL ? "postgres" : "memory", ready: false, error: null };
let pgPool = null;
const memQuotes = new Map(); // quoteId -> record
const memPayments = new Map(); // paymentId -> record
const memStripeEvents = new Set(); // stripe event ids we've already processed
let _dbInitPromise = null;

function pgSslConfigFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const sslmode = String(u.searchParams.get("sslmode") || "").toLowerCase();
    if (sslmode === "disable") return false;
    if (sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full") return { rejectUnauthorized: false };
  } catch {}
  const force = String(process.env.PGSSLMODE || "").toLowerCase();
  const dbSsl = String(process.env.DB_SSL || "").toLowerCase();
  if (force === "disable" || dbSsl === "false") return false;
  if (force === "require" || dbSsl === "true") return { rejectUnauthorized: false };
  // Heuristic: Render/managed DBs often require SSL
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) return { rejectUnauthorized: false };
  return false;
}

async function initDb() {
  if (!DATABASE_URL) {
    dbState.kind = "memory";
    dbState.ready = true;
    return;
  }
  try {
    const { Pool } = pg;
    const ssl = pgSslConfigFromUrl(DATABASE_URL);
    pgPool = new Pool({ connectionString: DATABASE_URL, ...(ssl ? { ssl } : {}) });
    await pgPool.query("SELECT 1");
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS booking_quotes (
        quote_id TEXT PRIMARY KEY,
        apartment_id INTEGER NOT NULL,
        arrival TEXT NOT NULL,
        departure TEXT NOT NULL,
        nights INTEGER NOT NULL,
        guests INTEGER NOT NULL,
        adults INTEGER,
        children INTEGER,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        discount_code TEXT,
        offer_token TEXT,
        offer_expires_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        meta JSONB
      );
      CREATE INDEX IF NOT EXISTS booking_quotes_expires_idx ON booking_quotes(expires_at);
      CREATE INDEX IF NOT EXISTS booking_quotes_status_idx ON booking_quotes(status);

      CREATE TABLE IF NOT EXISTS booking_payments (
        payment_id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL,
        stripe_intent_id TEXT,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        guest JSONB,
        extras JSONB,
        booking_id TEXT,
        booking_json JSONB,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS booking_payments_quote_idx ON booking_payments(quote_id);
      CREATE INDEX IF NOT EXISTS booking_payments_intent_idx ON booking_payments(stripe_intent_id);
      CREATE INDEX IF NOT EXISTS booking_payments_status_idx ON booking_payments(status);

      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        type TEXT NOT NULL,
        payment_id TEXT,
        stripe_intent_id TEXT
      );
    `);
    dbState.kind = "postgres";
    dbState.ready = true;
  } catch (e) {
    console.error("⚠️ DB init failed, falling back to in-memory storage:", e?.message || e);
    dbState.kind = "memory";
    dbState.ready = true;
    dbState.error = String(e?.message || e);
    pgPool = null;
  }
}

function ensureDb() {
  if (!_dbInitPromise) _dbInitPromise = initDb();
  return _dbInitPromise;
}

async function dbCreateQuote(rec) {
  await ensureDb();
  if (pgPool) {
    const meta = rec.meta ? JSON.stringify(rec.meta) : null;
    await pgPool.query(
      `INSERT INTO booking_quotes
        (quote_id, apartment_id, arrival, departure, nights, guests, adults, children, amount_cents, currency, discount_code, offer_token, offer_expires_at, status, created_at, expires_at, meta)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      [
        rec.quoteId,
        rec.apartmentId,
        rec.arrival,
        rec.departure,
        rec.nights,
        rec.guests,
        rec.adults ?? null,
        rec.children ?? null,
        rec.amountCents,
        rec.currency,
        rec.discountCode ?? null,
        rec.offerToken ?? null,
        rec.offerExpiresAt ? new Date(rec.offerExpiresAt) : null,
        rec.status || 'active',
        new Date(rec.createdAt),
        new Date(rec.expiresAt),
        meta,
      ]
    );
    return;
  }
  memQuotes.set(rec.quoteId, rec);
}

async function dbGetQuote(quoteId) {
  await ensureDb();
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT quote_id, apartment_id, arrival, departure, nights, guests, adults, children, amount_cents, currency, discount_code, offer_token, offer_expires_at, status, created_at, expires_at, meta
         FROM booking_quotes
        WHERE quote_id = $1
        LIMIT 1`,
      [quoteId]
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return null;
    return {
      quoteId: row.quote_id,
      apartmentId: row.apartment_id,
      arrival: row.arrival,
      departure: row.departure,
      nights: row.nights,
      guests: row.guests,
      adults: row.adults,
      children: row.children,
      amountCents: row.amount_cents,
      currency: row.currency,
      discountCode: row.discount_code,
      offerToken: row.offer_token,
      offerExpiresAt: row.offer_expires_at ? new Date(row.offer_expires_at).toISOString() : null,
      status: row.status,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      expiresAt,
      meta: row.meta || null,
    };
  }
  const rec = memQuotes.get(quoteId) || null;
  if (!rec) return null;
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
    memQuotes.delete(quoteId);
    return null;
  }
  return rec;
}

function nowIso() {
  return new Date().toISOString();
}

async function dbCreatePayment(rec) {
  await ensureDb();
  if (pgPool) {
    const guest = rec.guest ? JSON.stringify(rec.guest) : null;
    const extras = rec.extras ? JSON.stringify(rec.extras) : null;
    const bookingJson = rec.bookingJson ? JSON.stringify(rec.bookingJson) : null;
    await pgPool.query(
      `INSERT INTO booking_payments
        (payment_id, quote_id, stripe_intent_id, amount_cents, currency, status, created_at, updated_at, guest, extras, booking_id, booking_json, last_error)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13)`,
      [
        rec.paymentId,
        rec.quoteId,
        rec.stripeIntentId ?? null,
        rec.amountCents,
        rec.currency,
        rec.status,
        new Date(rec.createdAt),
        new Date(rec.updatedAt),
        guest,
        extras,
        rec.bookingId ?? null,
        bookingJson,
        rec.lastError ?? null,
      ]
    );
    return;
  }
  memPayments.set(rec.paymentId, rec);
}

async function dbUpdatePayment(paymentId, patch) {
  await ensureDb();
  const updatedAt = patch.updatedAt ? new Date(patch.updatedAt) : new Date();
  if (pgPool) {
    const fields = [];
    const values = [];
    let i = 1;
    const set = (col, val, castJson = false) => {
      fields.push(`${col} = $${i}${castJson ? '::jsonb' : ''}`);
      values.push(castJson ? JSON.stringify(val) : val);
      i++;
    };

    if (patch.quoteId !== undefined) set('quote_id', patch.quoteId);
    if (patch.stripeIntentId !== undefined) set('stripe_intent_id', patch.stripeIntentId);
    if (patch.amountCents !== undefined) set('amount_cents', patch.amountCents);
    if (patch.currency !== undefined) set('currency', patch.currency);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.guest !== undefined) set('guest', patch.guest, true);
    if (patch.extras !== undefined) set('extras', patch.extras, true);
    if (patch.bookingId !== undefined) set('booking_id', patch.bookingId);
    if (patch.bookingJson !== undefined) set('booking_json', patch.bookingJson, true);
    if (patch.lastError !== undefined) set('last_error', patch.lastError);
    set('updated_at', updatedAt);

    if (!fields.length) return;
    values.push(paymentId);
    await pgPool.query(`UPDATE booking_payments SET ${fields.join(', ')} WHERE payment_id = $${i}`, values);
    return;
  }

  const rec = memPayments.get(paymentId);
  if (!rec) return;
  const merged = { ...rec, ...patch, updatedAt: updatedAt.toISOString() };
  memPayments.set(paymentId, merged);
}

async function dbGetPayment(paymentId) {
  await ensureDb();
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT payment_id, quote_id, stripe_intent_id, amount_cents, currency, status, created_at, updated_at, guest, extras, booking_id, booking_json, last_error
         FROM booking_payments
        WHERE payment_id = $1
        LIMIT 1`,
      [paymentId]
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      paymentId: row.payment_id,
      quoteId: row.quote_id,
      stripeIntentId: row.stripe_intent_id,
      amountCents: row.amount_cents,
      currency: row.currency,
      status: row.status,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      guest: row.guest || null,
      extras: row.extras || null,
      bookingId: row.booking_id || null,
      bookingJson: row.booking_json || null,
      lastError: row.last_error || null,
    };
  }
  return memPayments.get(paymentId) || null;
}

async function dbGetPaymentByIntent(stripeIntentId) {
  await ensureDb();
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT payment_id, quote_id, stripe_intent_id, amount_cents, currency, status, created_at, updated_at, guest, extras, booking_id, booking_json, last_error
         FROM booking_payments
        WHERE stripe_intent_id = $1
        LIMIT 1`,
      [stripeIntentId]
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      paymentId: row.payment_id,
      quoteId: row.quote_id,
      stripeIntentId: row.stripe_intent_id,
      amountCents: row.amount_cents,
      currency: row.currency,
      status: row.status,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      guest: row.guest || null,
      extras: row.extras || null,
      bookingId: row.booking_id || null,
      bookingJson: row.booking_json || null,
      lastError: row.last_error || null,
    };
  }
  for (const rec of memPayments.values()) {
    if (rec?.stripeIntentId === stripeIntentId) return rec;
  }
  return null;
}

async function dbMarkStripeEventProcessed(eventId, { type, paymentId = null, stripeIntentId = null } = {}) {
  await ensureDb();
  if (pgPool) {
    const r = await pgPool.query(
      `INSERT INTO stripe_events (event_id, created_at, type, payment_id, stripe_intent_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, new Date(), type || 'unknown', paymentId, stripeIntentId]
    );
    return r.rowCount > 0;
  }
  if (memStripeEvents.has(eventId)) return false;
  memStripeEvents.add(eventId);
  return true;
}

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

// ---------------- Chat Snapshot Builder ----------------
// Generates a public snapshot with: unit descriptions + per-day availability + per-day prices.
// Refresh strategy:
// - cache in-memory for CHAT_SNAPSHOT_TTL_MS (default: 3h)
// - if stale and we still have a previous snapshot, we serve stale immediately and refresh in background

const _chatSnapshotCache = { ts: 0, ttlMs: CHAT_SNAPSHOT_TTL_MS, value: null, inFlight: null };
const _aptDetailsCache = new Map(); // apartmentId -> {ts, ttlMs, value}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function isoToday(tz = 'Europe/Vienna') {
  const ymd = ymdInTimeZone(new Date(), tz);
  if (!ymd) return null;
  return `${ymd.y}-${String(ymd.m).padStart(2, '0')}-${String(ymd.d).padStart(2, '0')}`;
}

function listIsoDays(startIso, days) {
  const out = [];
  for (let i = 0; i < days; i += 1) out.push(addDaysISO(startIso, i));
  return out;
}

async function getSmoobuApartmentsListCached() {
  const cached = cacheGet(cache.apartments);
  if (cached) return cached;
  const data = await smoobuFetch('/api/apartments', { method: 'GET', timeoutMs: 15000 });
  cache.apartments.ts = now();
  cache.apartments.value = data;
  return data;
}

async function getSmoobuApartmentDetailsCached(apartmentId) {
  const id = Number(apartmentId);
  if (!Number.isFinite(id)) return null;
  const now = Date.now();
  const hit = _aptDetailsCache.get(id);
  if (hit && now - hit.ts < hit.ttlMs) return hit.value;
  const data = await smoobuFetch(`/api/apartments/${id}`, { method: 'GET', timeoutMs: 15000 });
  _aptDetailsCache.set(id, { ts: now, ttlMs: CHAT_SNAPSHOT_APT_DETAILS_TTL_MS, value: data });
  return data;
}

function extractAmenityNames(details) {
  const out = [];
  const add = (x) => {
    const s = String(x || '').trim();
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };

  const lists = [details?.amenities, details?.equipments, details?.equipment, details?.amenity];
  for (const l of lists) {
    if (!Array.isArray(l)) continue;
    for (const it of l) {
      if (!it) continue;
      if (typeof it === 'string') add(it);
      else add(it.name || it.title || it.label);
    }
  }

  return out;
}

function buildApartmentDescription(details) {
  if (!details || typeof details !== 'object') return { text: '', fields: {} };

  const rooms = details.rooms && typeof details.rooms === 'object' ? details.rooms : {};
  const typeName = details?.type?.name || details?.type || '';

  const maxOcc = rooms.maxOccupancy ?? rooms.max_occupancy ?? rooms.max_occupancy_persons ?? null;
  const bedrooms = rooms.bedrooms ?? rooms.bedroom ?? null;
  const bathrooms = rooms.bathrooms ?? rooms.bathroom ?? null;

  const currency = details.currency || details?.price?.currency || null;
  const priceMin = details?.price?.minimal ?? details?.price?.min ?? null;
  const priceMax = details?.price?.maximal ?? details?.price?.max ?? null;

  const amenities = extractAmenityNames(details);

  const fields = {
    type: typeName || null,
    maxOccupancy: Number.isFinite(Number(maxOcc)) ? Number(maxOcc) : null,
    bedrooms: Number.isFinite(Number(bedrooms)) ? Number(bedrooms) : null,
    bathrooms: Number.isFinite(Number(bathrooms)) ? Number(bathrooms) : null,
    currency,
    priceMin,
    priceMax,
    amenities,
  };

  const parts = [];
  if (fields.type) parts.push(`Typ: ${fields.type}`);
  if (fields.maxOccupancy) parts.push(`Max. Personen: ${fields.maxOccupancy}`);
  if (fields.bedrooms) parts.push(`Schlafzimmer: ${fields.bedrooms}`);
  if (fields.bathrooms) parts.push(`Bäder: ${fields.bathrooms}`);
  if (fields.priceMin || fields.priceMax) parts.push(`Preisrahmen (Smoobu): ${fields.priceMin ?? '?'}–${fields.priceMax ?? '?'} ${fields.currency ?? ''}`.trim());
  if (amenities.length) parts.push(`Ausstattung (Auszug): ${amenities.slice(0, 20).join(', ')}${amenities.length > 20 ? ' …' : ''}`);

  return { text: parts.join(' | '), fields };
}

async function buildChatSnapshot({ days } = {}) {
  const d = clampInt(days ?? CHAT_SNAPSHOT_DAYS_DEFAULT, 1, 365, CHAT_SNAPSHOT_DAYS_DEFAULT);
  const start = isoToday('Europe/Vienna');
  if (!start) throw new Error('date_error');
  const end = addDaysISO(start, d - 1);

  const list = await getSmoobuApartmentsListCached();
  const apartments = Array.isArray(list?.apartments) ? list.apartments : [];
  const apartmentIds = apartments.map((a) => Number(a?.id)).filter((x) => Number.isFinite(x));

  // Load daily rates (price + availability) for the whole range and all apartments.
  const rates = await smoobuFetch('/api/rates', {
    method: 'GET',
    timeoutMs: 25000,
    query: { start_date: start, end_date: end, apartments: apartmentIds },
  });

  const daysList = listIsoDays(start, d);
  const ratesData = rates?.data && typeof rates.data === 'object' ? rates.data : rates;

  // Load apartment details (for descriptions) with a small concurrency limit.
  const detailsById = new Map();
  const concurrency = 4;
  let i = 0;
  const worker = async () => {
    while (i < apartmentIds.length) {
      const id = apartmentIds[i];
      i += 1;
      try {
        const det = await getSmoobuApartmentDetailsCached(id);
        if (det) detailsById.set(id, det);
      } catch (e) {
        // keep going – description is best-effort
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, apartmentIds.length) }, worker));

  const units = apartmentIds.map((id) => {
    const apt = apartments.find((a) => Number(a?.id) === id) || {};
    const unitFromMap = findUnitByApartmentId(id);
    const det = detailsById.get(id) || null;
    const desc = buildApartmentDescription(det);

    const ratesForId = (ratesData?.[id] || ratesData?.[String(id)] || null) ?? {};
    const calendar = daysList.map((date) => {
      const r = ratesForId?.[date] || null;
      const available = typeof r?.available === 'boolean' ? r.available : null;
      const price = r?.price ?? null;
      const minStay = r?.min_length_of_stay ?? r?.minLengthOfStay ?? null;
      return { date, available, price, min_length_of_stay: minStay };
    });

    return {
      apartment_id: id,
      name: apt?.name || unitFromMap?.name || `Apartment ${id}`,
      unit_id: unitFromMap?.unit_id || unitFromMap?.slug || null,
      category: unitFromMap?.category || null,
      details_url: unitFromMap?.details_url || unitFromMap?.url || null,
      description: desc.text,
      description_fields: desc.fields,
      calendar,
    };
  });

  return {
    ok: true,
    meta: {
      build: APP_BUILD,
      generatedAt: new Date().toISOString(),
      refreshMode: CHAT_SNAPSHOT_REFRESH_MODE,
      refreshHours: CHAT_SNAPSHOT_REFRESH_HOURS,
      lastWebhook: _smoobuWebhookState.action
        ? { action: _smoobuWebhookState.action, ts: new Date(_smoobuWebhookState.ts).toISOString() }
        : null,
      timezone: 'Europe/Vienna',
      start_date: start,
      end_date: end,
      days: d,
      source: 'smoobu:/api/rates',
    },
    units,
  };
}

async function writeChatStaticFiles(snapshot) {
  if (!CHAT_STATIC_WRITE) return;
  try {
    fs.mkdirSync(CHAT_STATIC_DIR, { recursive: true });
  } catch {}
  try {
    const html = buildChatIndexHtml(snapshot);
    const jsonPretty = JSON.stringify(snapshot, null, 2);
    const jsonMin = JSON.stringify(snapshot);
    fs.writeFileSync(path.join(CHAT_STATIC_DIR, 'index.html'), html, 'utf8');
    fs.writeFileSync(path.join(CHAT_STATIC_DIR, 'snapshot.json'), jsonPretty, 'utf8');
    fs.writeFileSync(path.join(CHAT_STATIC_DIR, 'snapshot.min.json'), jsonMin, 'utf8');
    _chatStaticFiles = { ok: true, ts: Date.now(), dir: CHAT_STATIC_DIR, error: null };
  } catch (e) {
    _chatStaticFiles = { ok: false, ts: Date.now(), dir: CHAT_STATIC_DIR, error: String(e?.message || e) };
    console.error('⚠️ chat static write failed:', _chatStaticFiles.error);
  }
}


async function refreshChatSnapshot({ days } = {}) {
  const snap = await buildChatSnapshot({ days });
  _chatSnapshotCache.ts = Date.now();
  _chatSnapshotCache.value = snap;
  // Also persist as static files (index.html + snapshot.json) for /chat/
  try {
    await writeChatStaticFiles(snap);
  } catch {}
  return snap;
}

async function getChatSnapshotCached({ days } = {}) {
  const d = clampInt(days ?? CHAT_SNAPSHOT_DAYS_DEFAULT, 1, 365, CHAT_SNAPSHOT_DAYS_DEFAULT);
  const now = Date.now();
  const age = now - _chatSnapshotCache.ts;

  // Fresh enough
  if (_chatSnapshotCache.value && age < _chatSnapshotCache.ttlMs) return _chatSnapshotCache.value;

  // If we have stale data, serve it immediately but refresh in background.
  if (_chatSnapshotCache.value) {
    if (!_chatSnapshotCache.inFlight) {
      _chatSnapshotCache.inFlight = refreshChatSnapshot({ days: d })
        .catch((e) => {
          console.error('⚠️ chat snapshot refresh failed:', e?.message || e);
          return null;
        })
        .finally(() => {
          _chatSnapshotCache.inFlight = null;
        });
    }
    return { ..._chatSnapshotCache.value, meta: { ..._chatSnapshotCache.value.meta, stale: true } };
  }

  // Cold start: block until we have data
  if (!_chatSnapshotCache.inFlight) {
    _chatSnapshotCache.inFlight = refreshChatSnapshot({ days: d }).finally(() => {
      _chatSnapshotCache.inFlight = null;
    });
  }
  return await _chatSnapshotCache.inFlight;
}

// --- Event-driven refresh helpers (Smoobu Webhooks) ---
// We debounce rebuilds to avoid hammering Smoobu when many events come in.
const CHAT_SNAPSHOT_WEBHOOK_DEBOUNCE_MS = Number(process.env.CHAT_SNAPSHOT_WEBHOOK_DEBOUNCE_MS || '4000');
const _chatSnapshotRebuild = {
  timer: null,
  inFlight: false,
  pending: false,
  lastReason: null,
  lastTriggerAt: 0,
};

function scheduleChatSnapshotRefresh(reason = 'event') {
  _chatSnapshotRebuild.lastReason = String(reason || 'event');
  _chatSnapshotRebuild.lastTriggerAt = Date.now();
  if (_chatSnapshotRebuild.timer) return; // already scheduled

  _chatSnapshotRebuild.timer = setTimeout(async () => {
    _chatSnapshotRebuild.timer = null;

    if (_chatSnapshotRebuild.inFlight) {
      _chatSnapshotRebuild.pending = true;
      return;
    }

    _chatSnapshotRebuild.inFlight = true;
    try {
      await refreshChatSnapshot({ days: CHAT_SNAPSHOT_DAYS_DEFAULT });
    } catch (e) {
      console.error('⚠️ chat snapshot webhook refresh failed:', e?.message || e);
    } finally {
      _chatSnapshotRebuild.inFlight = false;
      if (_chatSnapshotRebuild.pending) {
        _chatSnapshotRebuild.pending = false;
        scheduleChatSnapshotRefresh('pending');
      }
    }
  }, Math.max(0, CHAT_SNAPSHOT_WEBHOOK_DEBOUNCE_MS));
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

function normalizeCurrencyCode(cur) {
  const raw = String(cur || "").trim();
  if (!raw) return "EUR";
  const up = raw.toUpperCase();
  if (up in {"EUR":1,"EURO":1,"€":1}) return "EUR";
  const letters = up.replace(/[^A-Z]/g, "");
  if (letters.length === 3) return letters;
  return "EUR";
}

function amountToCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  // Smoobu prices are in major units (EUR). Stripe wants cents.
  return Math.round(n * 100);
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
    { type: "link", label: isEn ? "Open booking tool" : "Buchungstool öffnen", url: "/buchen/", kind: "primary" },
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
  actions.push({ type: "link", label: isEn ? "Open booking tool" : "Buchungstool öffnen", url: "/buchen/" });
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
    actions.push({ type: "link", label: isEn ? "Open booking tool" : "Buchungstool öffnen", url: "/buchen/", kind: "primary" });
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

function getSmoobuTimeoutMs(defaultMs = 25000) {
  const raw = Number(process.env.SMOOBU_TIMEOUT_MS || defaultMs);
  if (!Number.isFinite(raw)) return defaultMs;
  // Safety clamp (Render + Smoobu should not hang forever)
  return Math.max(5000, Math.min(raw, 60000));
}

async function smoobuFetch(path, { method = "GET", jsonBody, query, timeoutMs } = {}) {
  if (!SMOOBU_API_KEY) {
    const e = new Error("SMOOBU_API_KEY missing");
    e.status = 500;
    throw e;
  }
  const controller = new AbortController();
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : getSmoobuTimeoutMs();
  const t = setTimeout(() => controller.abort(), effectiveTimeoutMs);

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
// Keep raw request body for Stripe webhook signature verification.
// (Stripe requires the exact raw payload to validate the event signature.)
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

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

// ---------------- Smoobu Webhook (event driven) ----------------
// Configure in Smoobu API settings: https://.../api/smoobu/webhook?token=YOUR_TOKEN
// Smoobu sends actions like: updateRates, newReservation, updateReservation, cancelReservation, deleteReservation.
// We use this to refresh the /chat snapshot immediately after calendar/price changes.
app.post('/api/smoobu/webhook', (req, res) => {
  try {
    const token = String(req.query?.token || '').trim();
    if (SMOOBU_WEBHOOK_TOKEN && token !== SMOOBU_WEBHOOK_TOKEN) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const body = req.body || {};
    const action = String(body.action || '').trim();
    const user = body.user ?? null;

    _smoobuWebhookState.ts = Date.now();
    _smoobuWebhookState.action = action || null;
    _smoobuWebhookState.user = user;

    const triggers = new Set([
      'updateRates',
      'newReservation',
      'updateReservation',
      'cancelReservation',
      'deleteReservation',
      'priceElementCreated',
      'priceElementUpdated',
      'priceElementDeleted',
      'onlineCheckInUpdate',
      'newMessage',
    ]);

    if (triggers.has(action)) {
      scheduleChatSnapshotRefresh(`smoobu_webhook:${action}`);
    }

    // Respond quickly: the heavy work happens async.
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'webhook_error' });
  }
});

// Serve pre-generated chat files (index.html + snapshot.json) under /chat/...
// Files are written whenever the chat snapshot is refreshed (webhook / on-demand / interval).
if (CHAT_STATIC_SERVE) {
  try {
    fs.mkdirSync(CHAT_STATIC_DIR, { recursive: true });
  } catch {}
  app.use('/chat', express.static(CHAT_STATIC_DIR, {
    index: 'index.html',
    etag: false,
    fallthrough: true,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store');
    },
  }));
}

// ---------------- chat.alpenlodge.info ----------------
// Public index + machine-readable snapshot for the next 100 days (default).
// This is intended for GPT / voice agents to read current prices & availability deterministically.

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildChatIndexHtml(snapshot) {
  const snapPretty = JSON.stringify(snapshot, null, 2);
  // For the JSON-in-script-tag we replace '<' to prevent accidental </script> breaks.
  const snapScript = snapPretty.replace(/</g, '\u003c');

  const meta = snapshot?.meta || {};
  const title = 'Alpenlodge — Chat Data Feed';
  const updated = meta.generatedAt || '';
  const tz = meta.timezone || 'Europe/Vienna';
  const days = meta.days || CHAT_SNAPSHOT_DAYS_DEFAULT;
  const start = meta.start_date || '';
  const end = meta.end_date || '';
  const stale = meta.stale ? ' (stale – refresh in progress)' : '';

  const hint = (() => {
    if (CHAT_SNAPSHOT_REFRESH_MODE === 'interval') {
      return `Hinweis: Dieser Snapshot wird serverseitig gecached und ca. alle <strong>${escapeHtml(CHAT_SNAPSHOT_REFRESH_HOURS)}</strong> Stunden aktualisiert.`;
    }
    if (CHAT_SNAPSHOT_REFRESH_MODE === 'hybrid') {
      return `Hinweis: Dieser Snapshot wird per <strong>Smoobu Webhooks</strong> aktualisiert und zusätzlich ca. alle <strong>${escapeHtml(CHAT_SNAPSHOT_REFRESH_HOURS)}</strong> Stunden refreshed (Fallback).`;
    }
    // webhook (default)
    return `Hinweis: Dieser Snapshot wird primär per <strong>Smoobu Webhooks</strong> aktualisiert. Fallback: On-Demand Refresh, wenn die Daten älter als <strong>${escapeHtml(CHAT_SNAPSHOT_REFRESH_HOURS)}</strong> Stunden sind.`;
  })();

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body{font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin:24px; line-height:1.5; max-width: 1100px;}
    code,pre{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
    pre{padding:14px; background:#0b0f1a; color:#e8eefc; border-radius:12px; overflow:auto;}
    .muted{opacity:.75}
    .row{display:flex; gap:12px; flex-wrap:wrap; margin: 10px 0 18px;}
    .pill{display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:#f2f4f8;}
    a{color:#0b61ff;}
    h1{margin: 0 0 6px;}
    h2{margin-top:28px;}
    .warn{background:#fff4e5; padding:10px 12px; border-radius:10px;}
  </style>
</head>
<body>
  <h1>Alpenlodge — Chat Data Feed</h1>
  <div class="muted">Maschinenlesbare Verfügbarkeit & Tagespreise (Smoobu Rates) + Wohnungsdetails.</div>

  <div class="row">
    <div class="pill">Update: <strong>${escapeHtml(updated || '-')}${escapeHtml(stale)}</strong></div>
    <div class="pill">Zeitzone: <strong>${escapeHtml(tz)}</strong></div>
    <div class="pill">Zeitraum: <strong>${escapeHtml(start)} → ${escapeHtml(end)}</strong></div>
    <div class="pill">Tage: <strong>${escapeHtml(days)}</strong></div>
    <div class="pill"><a href="/api/chat/snapshot">JSON API</a></div>
  </div>

  <h2>Format / Regeln (wichtig)</h2>
  <ul>
    <li><strong>calendar[]</strong> enthält pro <strong>Datum</strong> die Felder: <code>available</code>, <code>price</code>, <code>min_length_of_stay</code>.</li>
    <li><strong>Preise sind Tagespreise / pro Nacht</strong>. Für einen Zeitraum <code>from → to</code> summierst du die Nächte: <code>from</code> bis <code>to - 1 Tag</code>.</li>
    <li>Eine Unterkunft ist für einen Zeitraum nur dann buchbar, wenn <strong>alle Nächte</strong> verfügbar sind und die Mindestnächte (<code>min_length_of_stay</code>) passen.</li>
    <li>Wenn <code>available</code> <code>false</code> oder <code>null</code> ist, ist der Tag nicht sicher verfügbar (blockiert / unbekannt).</li>
  </ul>

  <div class="warn">${hint}</div>

  <h2>Snapshot (JSON)</h2>
  <pre>${escapeHtml(snapPretty)}</pre>

  <script id="alpenlodge-snapshot" type="application/json">${snapScript}</script>
</body>
</html>`;
}

// Public Index
// Aliases:
// - chat.alpenlodge.info/            -> "/"
// - test.alpenlodge.info/chat        -> "/chat"
// This lets you run BOTH hostnames in the same Render service.
app.get(["/", "/index.html", "/chat", "/chat/", "/chat/index.html"], async (req, res) => {
  try {
    const days = req.query?.days;
    const snap = await getChatSnapshotCached({ days });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buildChatIndexHtml(snap));
  } catch (e) {
    res.status(500).send('chat_snapshot_error');
  }
});

// Machine-readable snapshot (JSON)
app.get('/api/chat/snapshot', async (req, res) => {
  try {
    const days = req.query?.days;
    const snap = await getChatSnapshotCached({ days });
    res.setHeader('Cache-Control', 'no-store');
    res.json(snap);
  } catch (e) {
    console.error('❌ /api/chat/snapshot error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'chat_snapshot_error' });
  }
});

// Convenience aliases for the snapshot (same JSON).
// Useful if you proxy only /chat on another hostname.
app.get(['/chat/snapshot', '/chat/snapshot.json', '/chat/api'], async (req, res) => {
  try {
    const days = req.query?.days;
    const snap = await getChatSnapshotCached({ days });
    res.setHeader('Cache-Control', 'no-store');
    res.json(snap);
  } catch (e) {
    console.error('❌ /chat/snapshot error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'chat_snapshot_error' });
  }
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

// DB visibility (no secrets). Used to verify DATABASE_URL / connection on Render.
app.get("/api/debug/db", async (req, res) => {
  await ensureDb();
  res.json({
    ok: true,
    db: {
      kind: dbState.kind,
      ready: dbState.ready,
      databaseUrlSet: Boolean(DATABASE_URL),
      error: dbState.error || null,
    },
    quote: {
      ttlMinutes: BOOKING_QUOTE_TTL_MIN,
    },
  });
});

// Chat feed / file generation debug (no secrets).
app.get("/api/debug/chat", (req, res) => {
  const cacheAgeSeconds = _chatSnapshotCache.ts ? Math.round((Date.now() - _chatSnapshotCache.ts) / 1000) : null;
  res.json({
    ok: true,
    chat: {
      build: APP_BUILD,
      daysDefault: CHAT_SNAPSHOT_DAYS_DEFAULT,
      refreshMode: CHAT_SNAPSHOT_REFRESH_MODE,
      refreshHours: CHAT_SNAPSHOT_REFRESH_HOURS,
      webhook: {
        tokenProtected: Boolean(SMOOBU_WEBHOOK_TOKEN),
        last: {
          ts: _smoobuWebhookState.ts || null,
          action: _smoobuWebhookState.action || null,
          user: _smoobuWebhookState.user || null,
        },
        debounceMs: CHAT_SNAPSHOT_WEBHOOK_DEBOUNCE_MS,
        rebuild: {
          lastTriggerAt: _chatSnapshotRebuild.lastTriggerAt || null,
          lastReason: _chatSnapshotRebuild.lastReason || null,
          inFlight: Boolean(_chatSnapshotRebuild.inFlight),
          scheduled: Boolean(_chatSnapshotRebuild.timer),
          pending: Boolean(_chatSnapshotRebuild.pending),
        },
      },
      static: {
        dir: CHAT_STATIC_DIR,
        serve: CHAT_STATIC_SERVE,
        write: CHAT_STATIC_WRITE,
        lastWrite: _chatStaticFiles,
      },
      cache: {
        lastRefreshTs: _chatSnapshotCache.ts || null,
        cacheAgeSeconds,
        hasSnapshot: Boolean(_chatSnapshotCache.value),
      },
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
    build: APP_BUILD,
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

// Preferred API namespace for website booking widgets / landing pages
app.post("/api/booking/availability", rateLimit, smoobuAvailabilityHandler);

// Step 1 (Stripe-ready): Create a server-side quote for ONE apartment.
// - Calls Smoobu availability/price
// - Returns nights + total price + price/night
// - Persists the quote in DB (or memory fallback) with a TTL
async function bookingQuoteHandler(req, res) {
  try {
    if (!SMOOBU_CUSTOMER_ID) {
      return res.status(500).json({ error: "SMOOBU_CUSTOMER_ID missing" });
    }

    const body = req.body || {};

    const apartmentIdRaw =
      body.apartmentId ??
      body.apartment_id ??
      body.smoobuApartmentId ??
      body.smoobu_id ??
      body.id ??
      null;

    const apartmentId = Number(apartmentIdRaw);
    if (!Number.isFinite(apartmentId)) {
      return res.status(400).json({
        error: "apartmentId_required",
        hint: "Provide apartmentId (Smoobu apartment id).",
      });
    }

    const arrivalRaw = body.arrivalDate ?? body.arrival ?? body.from ?? body.checkin ?? "";
    const departureRaw = body.departureDate ?? body.departure ?? body.to ?? body.checkout ?? "";

    const aIso = toISODate(arrivalRaw);
    const dIso = toISODate(departureRaw);

    if (!aIso || !dIso) {
      return res.status(400).json({
        error: "dates_required",
        hint: "Provide arrivalDate/from and departureDate/to (YYYY-MM-DD or D.M.YY).",
      });
    }

    if (String(dIso) <= String(aIso)) {
      return res.status(400).json({
        error: "invalid_date_range",
        hint: "departureDate must be after arrivalDate.",
        validation_messages: {
          departureDate: { callbackValue: "Departure date can't be before arrival date" },
        },
      });
    }

    const adultsRaw = body.adults;
    const childrenRaw = body.children;
    const adults = adultsRaw === undefined || adultsRaw === null || adultsRaw === "" ? null : Number(adultsRaw);
    const children = childrenRaw === undefined || childrenRaw === null || childrenRaw === "" ? null : Number(childrenRaw);

    const guestsRaw =
      body.guests ??
      (Number.isFinite(adults) || Number.isFinite(children) ? Number(adults || 0) + Number(children || 0) : null);

    const guests = Number(guestsRaw);
    if (!Number.isFinite(guests) || guests <= 0 || guests >= 30) {
      return res.status(400).json({
        error: "guests_required",
        hint: "Provide guests (or adults + children).",
      });
    }

    const discountCode =
      typeof body.discountCode === "string"
        ? body.discountCode.trim()
        : typeof body.discount === "string"
        ? body.discount.trim()
        : "";

    const unit = findUnitByApartmentId(apartmentId);
    if (unit?.max_persons && guests > Number(unit.max_persons)) {
      return res.status(400).json({
        error: "guests_exceed_max",
        hint: `Maximale Personenanzahl für diese Einheit: ${unit.max_persons}.`,
        max_persons: Number(unit.max_persons),
      });
    }

    const payload = {
      arrivalDate: aIso,
      departureDate: dIso,
      apartments: [apartmentId],
      customerId: Number(SMOOBU_CUSTOMER_ID),
      guests,
    };
    if (discountCode) payload.discountCode = discountCode;

    const data = await smoobuFetch("/booking/checkApartmentAvailability", {
      method: "POST",
      jsonBody: payload,
    });

    const availableApartments = Array.isArray(data?.availableApartments) ? data.availableApartments.map(Number) : [];
    const isAvailable = availableApartments.includes(apartmentId);

    if (!isAvailable) {
      return res.status(409).json({
        ok: false,
        available: false,
        error: "not_available",
        apartmentId,
        arrivalDate: aIso,
        departureDate: dIso,
        guests,
      });
    }

    const priceInfo = data?.prices?.[String(apartmentId)] || data?.prices?.[apartmentId] || null;
    const amount = Number(priceInfo?.price ?? NaN);
    const currency = normalizeCurrencyCode(priceInfo?.currency || "EUR");
    const amountCents = amountToCents(amount);

    const nights = nightsBetween(aIso, dIso);
    if (!Number.isFinite(nights) || nights <= 0) {
      return res.status(400).json({
        error: "invalid_nights",
        hint: "Check arrival/departure dates.",
      });
    }

    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(502).json({
        error: "price_missing",
        hint: "Smoobu returned no price for this unit/date/guests.",
        apartmentId,
        priceInfo,
      });
    }

    const quoteId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + BOOKING_QUOTE_TTL_MS).toISOString();

    // Optional: create a signed offer token (can be used for booking later).
    let offerToken = null;
    let offerExpiresAt = null;
    try {
      // Keep token TTL aligned with quote TTL (but never less than 5 min / never more than 20 min by default).
      const exp = Date.now() + BOOKING_QUOTE_TTL_MS;
      offerToken = signOffer({
        apartmentId,
        arrivalDate: aIso,
        departureDate: dIso,
        guests,
        price: amount,
        currency,
        discountCode: discountCode || null,
        exp,
      });
      offerExpiresAt = new Date(exp).toISOString();
    } catch {
      offerToken = null;
      offerExpiresAt = null;
    }

    const rec = {
      quoteId,
      apartmentId,
      arrival: aIso,
      departure: dIso,
      nights,
      guests,
      adults: Number.isFinite(adults) ? adults : null,
      children: Number.isFinite(children) ? children : null,
      amountCents,
      currency,
      discountCode: discountCode || null,
      offerToken,
      offerExpiresAt,
      status: "active",
      createdAt,
      expiresAt,
      meta: {
        source: "smoobu",
        unit: unit
          ? {
              name: unit.name || null,
              category: unit.category || null,
              details_url: unit.details_url || null,
              smoobu_id: Number(unit.smoobu_id) || apartmentId,
            }
          : null,
      },
    };

    await dbCreateQuote(rec);

    res.json({
      ok: true,
      quoteId,
      createdAt,
      expiresAt,
      offerToken,
      offerExpiresAt,
      unit: unit
        ? {
            apartmentId,
            name: unit.name,
            category: unit.category,
            details_url: unit.details_url,
            max_persons: unit.max_persons ? Number(unit.max_persons) : null,
          }
        : { apartmentId },
      stay: {
        arrivalDate: aIso,
        departureDate: dIso,
        nights,
        guests,
        adults: Number.isFinite(adults) ? adults : null,
        children: Number.isFinite(children) ? children : null,
      },
      price: {
        amount,
        amountCents,
        currency,
        perNight: Math.round((amount / nights) * 100) / 100,
        perNightCents: Math.round(amountCents / nights),
      },
    });
  } catch (err) {
    console.error("❌ Quote error:", err);
    res.status(err.status || 500).json({
      error: "quote_error",
      details: err.details || { message: err?.message || String(err) },
    });
  }
}

app.post("/api/booking/quote", rateLimit, bookingQuoteHandler);

// Debug / internal usage: fetch a quote by id (returns 404 when expired).
app.get("/api/booking/quote/:quoteId", async (req, res) => {
  try {
    const quoteId = String(req.params.quoteId || "").trim();
    if (!quoteId) return res.status(400).json({ ok: false, error: "quoteId_required" });
    const q = await dbGetQuote(quoteId);
    if (!q) return res.status(404).json({ ok: false, error: "quote_not_found_or_expired" });
    res.json({ ok: true, quote: q });
  } catch (err) {
    console.error("❌ Get quote error:", err);
    res.status(500).json({ ok: false, error: "quote_get_error" });
  }
});

// ---------------- Stripe payment (Payment Element) ----------------
// We create the PaymentIntent only after we created a server-side quote.
// Booking in Smoobu happens ONLY after Stripe confirms payment (webhook).

function isStripeEnabled() {
  return Boolean(stripe && STRIPE_PUBLISHABLE_KEY && STRIPE_WEBHOOK_SECRET);
}

function toStripeCurrency(cur) {
  const raw = String(cur || "").trim();
  if (!raw) return STRIPE_CURRENCY_DEFAULT;
  const upper = raw.toUpperCase();
  if (upper === "€" || upper === "EUR") return "eur";
  if (/^[A-Z]{3}$/.test(upper)) return upper.toLowerCase();
  return STRIPE_CURRENCY_DEFAULT;
}

app.get("/api/payment/stripe/config", async (_req, res) => {
  // This is safe to expose: publishable key is intended for client-side usage.
  // If Stripe isn't configured, frontend can fall back to "book now" without payment.
  res.json({
    ok: true,
    enabled: Boolean(stripe && STRIPE_PUBLISHABLE_KEY),
    publishableKey: STRIPE_PUBLISHABLE_KEY || null,
  });
});

app.get("/api/payment/stripe/status/:paymentId", async (req, res) => {
  try {
    const paymentId = String(req.params.paymentId || "").trim();
    if (!paymentId) return res.status(400).json({ ok: false, error: "paymentId_required" });
    const p = await dbGetPayment(paymentId);
    if (!p) return res.status(404).json({ ok: false, error: "payment_not_found" });
    res.json({
      ok: true,
      payment: {
        paymentId: p.paymentId,
        quoteId: p.quoteId,
        stripeIntentId: p.stripeIntentId,
        amountCents: p.amountCents,
        currency: p.currency,
        status: p.status,
        bookingId: p.bookingId,
        lastError: p.lastError || null,
        updatedAt: p.updatedAt,
        createdAt: p.createdAt,
      },
    });
  } catch (err) {
    console.error("❌ payment status error:", err);
    res.status(500).json({ ok: false, error: "payment_status_error" });
  }
});

app.post("/api/payment/stripe/create-intent", rateLimit, async (req, res) => {
  try {
    if (!stripe || !STRIPE_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "stripe_not_configured" });
    }
    if (!STRIPE_PUBLISHABLE_KEY) {
      return res.status(500).json({ ok: false, error: "stripe_publishable_key_missing" });
    }
    if (!STRIPE_WEBHOOK_SECRET) {
      return res.status(500).json({ ok: false, error: "stripe_webhook_secret_missing" });
    }

    // For production Stripe flow we REQUIRE a real database (Render Postgres).
    // In-memory fallback would lose state between restarts and break the webhook.
    await ensureDb();
    if (!pgPool) {
      return res.status(500).json({
        ok: false,
        error: "db_required",
        hint: "Set DATABASE_URL in Render so payment + booking state can be persisted.",
      });
    }

    const body = req.body || {};
    const quoteId = typeof body.quoteId === "string" ? body.quoteId.trim() : "";
    if (!quoteId) {
      return res.status(400).json({
        ok: false,
        error: "quoteId_required",
        hint: "Create a quote first via POST /api/booking/quote.",
      });
    }

    const quote = await dbGetQuote(quoteId);
    if (!quote) return res.status(404).json({ ok: false, error: "quote_not_found_or_expired" });
    if (quote.status && quote.status !== "active") {
      return res.status(409).json({ ok: false, error: "quote_not_active", status: quote.status });
    }

    // Guest data (PII stays in OUR DB, not in Stripe metadata)
    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const country = typeof body.country === "string" ? body.country.trim() : "";
    const language = typeof body.language === "string" ? body.language.trim() : "de";
    const notice = typeof body.notice === "string" ? body.notice.trim() : "";

    const addressObj = (() => {
      if (body.address && typeof body.address === "object") {
        const street = typeof body.address.street === "string" ? body.address.street.trim() : "";
        const postalCode = typeof body.address.postalCode === "string" ? body.address.postalCode.trim() : "";
        const location = typeof body.address.location === "string" ? body.address.location.trim() : "";
        return { street, postalCode, location };
      }
      const street = typeof body.street === "string" ? body.street.trim() : "";
      const postalCode = typeof body.postalCode === "string" ? body.postalCode.trim() : (typeof body.zip === "string" ? body.zip.trim() : "");
      const location = typeof body.location === "string" ? body.location.trim() : (typeof body.city === "string" ? body.city.trim() : "");
      return { street, postalCode, location };
    })();

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
      return res.status(400).json({ ok: false, error: "missing_guest_fields", missing });
    }

    // Guests: optional override; default from quote
    const adults = Number(body.adults ?? quote.adults ?? quote.guests);
    const children = Number(body.children ?? quote.children ?? 0);
    const guests = Number(body.guests ?? (adults + children) ?? quote.guests);

    // Extras
    const extrasIn = body && typeof body.extras === "object" && body.extras ? body.extras : {};
    const dogs = Math.max(0, Math.min(9, Number(extrasIn.dogs ?? body.dogs ?? 0) || 0));

    const nights = Number(quote.nights) || 0;
    const dogExtraCents = dogs > 0 && nights > 0 && DOG_PRICE_PER_NIGHT_CENTS > 0
      ? dogs * nights * DOG_PRICE_PER_NIGHT_CENTS
      : 0;

    const stayAmountCents = Number(quote.amountCents) || 0;
    const amountCents = stayAmountCents + dogExtraCents;

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_amount" });
    }

    const currency = toStripeCurrency(quote.currency);
    const paymentId = crypto.randomUUID();
    const createdAt = nowIso();

    const paymentRec = {
      paymentId,
      quoteId,
      stripeIntentId: null,
      amountCents,
      currency,
      status: "payment_pending",
      createdAt,
      updatedAt: createdAt,
      guest: { firstName, lastName, email, phone, address: addressObj, country, language, notice, adults, children, guests },
      extras: { dogs, dogPricePerNightCents: DOG_PRICE_PER_NIGHT_CENTS, nights, dogExtraCents },
      bookingId: null,
      bookingJson: null,
      lastError: null,
    };

    await dbCreatePayment(paymentRec);

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        paymentId,
        quoteId,
        apartmentId: String(quote.apartmentId),
        arrival: String(quote.arrival),
        departure: String(quote.departure),
      },
    });

    if (!intent?.id || !intent?.client_secret) {
      await dbUpdatePayment(paymentId, { status: "intent_error", lastError: "Stripe PaymentIntent missing id/client_secret" });
      return res.status(502).json({ ok: false, error: "stripe_intent_failed" });
    }

    await dbUpdatePayment(paymentId, { stripeIntentId: intent.id, status: "intent_created", updatedAt: nowIso() });

    res.json({
      ok: true,
      paymentId,
      quoteId,
      clientSecret: intent.client_secret,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      amountCents,
      currency,
      breakdown: {
        stayAmountCents,
        dogExtraCents,
      },
    });
  } catch (err) {
    console.error("❌ create-intent error:", err);
    const status = err?.status || 500;
    res.status(status).json({ ok: false, error: "create_intent_error", details: err?.details || { message: err?.message || String(err) } });
  }
});

async function createSmoobuReservationForPayment({ quote, payment, stripeIntentId }) {
  if (!quote || typeof quote !== "object") throw new Error("missing_quote");
  if (!payment || typeof payment !== "object") throw new Error("missing_payment");

  const guest = payment.guest || {};
  const addressObj = guest.address && typeof guest.address === "object" ? guest.address : null;

  const missing = [];
  if (!guest.firstName) missing.push("firstName");
  if (!guest.lastName) missing.push("lastName");
  if (!guest.email) missing.push("email");
  if (!guest.phone) missing.push("phone");
  if (!guest.country) missing.push("country");
  if (!addressObj?.street) missing.push("address.street");
  if (!addressObj?.postalCode) missing.push("address.postalCode");
  if (!addressObj?.location) missing.push("address.location");

  if (missing.length) {
    const err = new Error("missing_guest_fields");
    err.details = { missing };
    throw err;
  }

  // Offer derived from quote (server-side source of truth)
  const offer = {
    apartmentId: Number(quote.apartmentId),
    arrivalDate: String(quote.arrival),
    departureDate: String(quote.departure),
    guests: Number(quote.guests),
    price: Math.round((Number(quote.amountCents) || 0)) / 100,
    currency: String(quote.currency || "EUR"),
  };

  const adults = Number.isFinite(Number(guest.adults)) ? Number(guest.adults) : (Number(quote.adults) || offer.guests);
  const children = Number.isFinite(Number(guest.children)) ? Number(guest.children) : (Number(quote.children) || 0);

  const extras = payment.extras && typeof payment.extras === "object" ? payment.extras : {};
  const dogs = Math.max(0, Math.min(9, Number(extras.dogs ?? 0) || 0));
  const nights = Number(extras.nights ?? quote.nights ?? 0) || 0;
  const dogExtraCents = Number(extras.dogExtraCents ?? 0) || 0;

  const noticeParts = [];
  if (guest.notice) noticeParts.push(String(guest.notice).trim());
  if (stripeIntentId) noticeParts.push(`Stripe PaymentIntent: ${stripeIntentId}`);
  if (dogs > 0 && dogExtraCents > 0) {
    noticeParts.push(`Hund: ${dogs}x (Extra ${Math.round(dogExtraCents) / 100} ${offer.currency})`);
  }
  const notice = noticeParts.filter(Boolean).join("\n");

  const reservationPayload = {
    arrivalDate: offer.arrivalDate,
    departureDate: offer.departureDate,
    apartmentId: offer.apartmentId,
    channelId: Number.isFinite(SMOOBU_CHANNEL_ID) ? SMOOBU_CHANNEL_ID : 70,

    firstName: String(guest.firstName),
    lastName: String(guest.lastName),
    email: String(guest.email),
    phone: String(guest.phone),
    address: {
      street: String(addressObj.street),
      postalCode: String(addressObj.postalCode),
      location: String(addressObj.location),
    },
    country: String(guest.country),
    language: String(guest.language || "de"),

    adults: Number.isFinite(adults) ? adults : offer.guests,
    children: Number.isFinite(children) ? children : 0,

    // Base stay price from quote. Extras are applied as price elements.
    price: offer.price,
    notice,
  };

  const result = await smoobuFetch("/api/reservations", {
    method: "POST",
    jsonBody: reservationPayload,
  });

  const bookingId = result?.id ?? result?.reservationId ?? null;

  // 🔄 Update chat snapshot after a successful Stripe-paid booking
  try {
    if (bookingId) scheduleChatSnapshotRefresh('booking_created:stripe');
  } catch {}

  const extrasApplied = { dogs: 0, nights: 0, dogExtra: 0, addedPriceElements: [], errors: [] };
  extrasApplied.dogs = dogs;
  extrasApplied.nights = nights;
  extrasApplied.dogExtra = Math.round(dogExtraCents) / 100;

  // Add dog extra as price element in Smoobu (best effort)
  if (bookingId && dogs > 0 && dogExtraCents > 0 && nights > 0) {
    const amount = Math.round(dogExtraCents) / 100;
    const pePayload = {
      name: `Hund (${dogs}x)`,
      amount,
      tax: 0,
      calculationType: 0,
    };
    try {
      const peRes = await smoobuFetch(`/api/reservations/${encodeURIComponent(bookingId)}/price-elements`, {
        method: "POST",
        jsonBody: pePayload,
      });
      extrasApplied.addedPriceElements.push({ type: "dog", amount, response: peRes });
    } catch (e) {
      extrasApplied.errors.push({ type: "dog", details: e?.details || { message: e?.message || String(e) } });
    }
  }

  return {
    bookingId,
    reservation: result,
    offerUsed: {
      apartmentId: offer.apartmentId,
      arrival: offer.arrivalDate,
      departure: offer.departureDate,
      guests: offer.guests,
      price: offer.price,
      currency: offer.currency,
    },
    extrasApplied,
  };
}

app.post("/api/payment/stripe/webhook", async (req, res) => {
  // Stripe will retry webhooks. This endpoint MUST be idempotent.
  try {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(500).send("Stripe not configured");
    }
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("Missing stripe-signature");

    let event;
    try {
      const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      console.error("❌ stripe webhook signature verification failed:", e?.message || e);
      return res.status(400).send("Webhook signature verification failed");
    }

    const eventId = event?.id || "";
    const type = event?.type || "";
    const obj = event?.data?.object || null;
    const stripeIntentId = obj?.id || null;
    let paymentId = obj?.metadata?.paymentId || null;

    // If metadata is missing, try resolving our paymentId from the PaymentIntent id.
    if (!paymentId && stripeIntentId) {
      const p2 = await dbGetPaymentByIntent(stripeIntentId);
      if (p2?.paymentId) paymentId = p2.paymentId;
    }

    // Record event id (dedupe)
    const isNew = eventId ? await dbMarkStripeEventProcessed(eventId, { type, paymentId, stripeIntentId }) : true;
    if (!isNew) {
      return res.status(200).json({ ok: true, received: true, duplicate: true });
    }

    if (!paymentId) {
      // Nothing we can do. Still return 200 so Stripe doesn't retry forever.
      return res.status(200).json({ ok: true, received: true, ignored: true });
    }

    const payment = await dbGetPayment(paymentId);
    if (!payment) {
      return res.status(200).json({ ok: true, received: true, ignored: true });
    }

    // Status updates
    if (type === "payment_intent.succeeded") {
      await dbUpdatePayment(paymentId, { status: "paid", updatedAt: nowIso() });

      // Finalize booking (Smoobu)
      try {
        const quote = await dbGetQuote(payment.quoteId);
        if (!quote) {
          await dbUpdatePayment(paymentId, { status: "booking_failed", lastError: "quote_not_found_or_expired", updatedAt: nowIso() });
          return res.status(200).json({ ok: true, received: true });
        }

        const booking = await createSmoobuReservationForPayment({ quote, payment, stripeIntentId });
        await dbUpdatePayment(paymentId, {
          status: "booked",
          bookingId: booking.bookingId,
          bookingJson: booking,
          lastError: null,
          updatedAt: nowIso(),
        });
      } catch (e) {
        console.error("❌ booking after payment failed:", e?.message || e);
        await dbUpdatePayment(paymentId, {
          status: "booking_failed",
          lastError: e?.message || String(e),
          bookingJson: { error: e?.details || { message: e?.message || String(e) } },
          updatedAt: nowIso(),
        });
      }
    } else if (type === "payment_intent.payment_failed") {
      const msg = obj?.last_payment_error?.message || "payment_failed";
      await dbUpdatePayment(paymentId, { status: "payment_failed", lastError: msg, updatedAt: nowIso() });
    } else if (type === "payment_intent.canceled") {
      await dbUpdatePayment(paymentId, { status: "payment_canceled", updatedAt: nowIso() });
    }

    return res.status(200).json({ ok: true, received: true });
  } catch (err) {
    console.error("❌ stripe webhook handler error:", err);
    // Return 200 to avoid infinite retries on our internal errors.
    return res.status(200).json({ ok: true, received: true });
  }
});

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

async function smoobuBookHandler(req, res) {
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

    // Some Smoobu setups require address/country/phone for direct bookings.
    // In the Smoobu API, "address" is an object:
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
      notice,
    };

    // Create booking in Smoobu
    const result = await smoobuFetch("/api/reservations", {
      method: "POST",
      jsonBody: reservationPayload,
    });

    // Some Smoobu responses return {id:...} others {reservationId:...}
    const bookingId = result?.id ?? result?.reservationId ?? null;

    // 🔄 Update chat snapshot so chat.alpenlodge.info reflects the new reservation quickly
    try {
      if (bookingId) scheduleChatSnapshotRefresh('booking_created:concierge_book');
    } catch {}

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

app.post("/concierge/book", rateLimit, smoobuBookHandler);
app.post("/api/booking/book", rateLimit, smoobuBookHandler);

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
app.listen(PORT, () => {
  console.log(`🤖 Concierge listening on ${PORT}`);

  // Warm up chat snapshot (non-blocking) + keep it fresh.
  // Note: Render instances may sleep; snapshot refresh is also triggered on-demand.
  refreshChatSnapshot({ days: CHAT_SNAPSHOT_DAYS_DEFAULT }).catch((e) => {
    console.error('⚠️ chat snapshot warmup failed:', e?.message || e);
  });

  if (CHAT_SNAPSHOT_REFRESH_MODE === 'interval' || CHAT_SNAPSHOT_REFRESH_MODE === 'hybrid') {
    setInterval(() => {
      refreshChatSnapshot({ days: CHAT_SNAPSHOT_DAYS_DEFAULT }).catch((e) => {
        console.error('⚠️ chat snapshot scheduled refresh failed:', e?.message || e);
      });
    }, CHAT_SNAPSHOT_TTL_MS);
  }
});
