#!/usr/bin/env node
/**
 * Alpenlodge Concierge — Smoke Test Runner
 *
 * Ziel: Schnell prüfen, ob die wichtigsten Endpunkte & Guardrails laufen.
 *
 * Usage:
 *   BASE_URL=http://localhost:3001 node tests/smoke.mjs
 *   BASE_URL=https://alpenlodge-concierge.onrender.com node tests/smoke.mjs --strict
 *
 * Optional:
 *   ADMIN_TOKEN=...  (für Admin-only Tests)
 *   TEST_ARRIVAL=2026-02-01
 *   TEST_DEPARTURE=2026-02-05
 *   TEST_GUESTS=2
 */

import crypto from "node:crypto";
import process from "node:process";

const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

const TEST_ARRIVAL = (process.env.TEST_ARRIVAL || "2026-02-01").trim();
const TEST_DEPARTURE = (process.env.TEST_DEPARTURE || "2026-02-05").trim();
const TEST_GUESTS = Number(process.env.TEST_GUESTS || "2");

const SESSION_ID = (process.env.SESSION_ID || `smoke-${crypto.randomBytes(6).toString("hex")}`).trim();

function okUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function okRelOrHttpUrl(u) {
  const s = String(u || "").trim();
  if (!s) return false;
  if (s.startsWith("/")) return true;
  return okUrl(s);
}

function hasInternalMarker(x) {
  return String(x || "").toUpperCase().includes("INTERNAL");
}

function containsHttpInText(t) {
  return /https?:\/\//i.test(String(t || ""));
}

function isLikelyMultiUrlString(u) {
  // In eurem Knowledge tauchen Quellen manchmal als "url1 | url2" auf.
  // Das ist als *ein* Link unbrauchbar.
  return /\s\|\s/.test(String(u || ""));
}

function line(title, status, extra = "") {
  const s = String(status).padEnd(5, " ");
  const e = extra ? ` — ${extra}` : "";
  console.log(`${s} ${title}${e}`);
}

function fail(title, msg) {
  line(title, "FAIL", msg);
  process.exitCode = 1;
}

function pass(title, msg = "") {
  line(title, "PASS", msg);
}

function warn(title, msg) {
  line(title, "WARN", msg);
  if (STRICT) {
    process.exitCode = 1;
  }
}

async function reqJson(method, path, { body, headers, query } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, String(vv)));
      else url.searchParams.set(k, String(v));
    }
  }

  const init = {
    method,
    headers: {
      ...(headers || {}),
    },
  };

  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { res, json, text };
}

function checkLinksArray(title, links) {
  if (!Array.isArray(links)) return;
  for (const l of links) {
    const label = l?.label;
    const url = l?.url;

    if (hasInternalMarker(label) || hasInternalMarker(url)) {
      fail(title, `INTERNAL im links[] gefunden: ${JSON.stringify(l)}`);
      continue;
    }
if (typeof label === "string" && /quelle/i.test(label)) {
  fail(title, `links[] label enthält 'Quelle' (bitte neutral beschriften): ${JSON.stringify(l)}`);
  continue;
}

    if (!okUrl(url)) {
      fail(title, `Ungültige URL in links[]: ${JSON.stringify(l)}`);
      continue;
    }

    if (isLikelyMultiUrlString(url)) {
      fail(title, `links[] URL enthält mehrere URLs (" | "): ${JSON.stringify(l)}`);
      continue;
    }
  }
}

function checkActionsArray(title, actions) {
  if (!Array.isArray(actions)) return;
  for (const a of actions) {
    const type = a?.type;
    if (type === "link") {
      if (!okRelOrHttpUrl(a?.url)) {
        fail(title, `Ungültige action.link url: ${JSON.stringify(a)}`);
      }
    } else if (type === "postback") {
      if (!String(a?.message || "").trim()) {
        fail(title, `action.postback ohne message: ${JSON.stringify(a)}`);
      }
    } else {
      warn(title, `Unbekannter action.type: ${JSON.stringify(a)}`);
    }
  }
}

function checkReplyClean(title, reply) {
  if (hasInternalMarker(reply)) {
    fail(title, "INTERNAL Marker im reply Text gefunden");
  }
if (/offizielle\s+quellen|quellen\s*\/\s*verzeichnisse/i.test(String(reply || ""))) {
  fail(title, "reply enthält 'Offizielle Quellen/Verzeichnisse' — das darf nicht angezeigt werden");
}
if (/\(\s*quelle\s*\)/i.test(String(reply || ""))) {
  fail(title, "reply enthält '(Quelle)' — Links sollen neutral in links[] stehen");
}
  if (STRICT && containsHttpInText(reply)) {
    fail(title, "reply enthält http(s) URL — laut Regel sollen URLs nur in links[] stehen");
  } else if (!STRICT && containsHttpInText(reply)) {
    warn(title, "reply enthält http(s) URL (ggf. sollte das in links[] ausgelagert werden)");
  }
}

async function main() {
  console.log(`\nAlpenlodge Concierge Smoke Test`);
  console.log(`BASE_URL:   ${BASE_URL}`);
  console.log(`STRICT:     ${STRICT ? "yes" : "no"}`);
  console.log(`SESSION_ID: ${SESSION_ID}`);
  console.log(`ADMIN_TOKEN: ${ADMIN_TOKEN ? "set" : "not set"}`);

  // 1) Health
  try {
    const { res, json } = await reqJson("GET", "/health");
    if (!res.ok || json?.status !== "ok") fail("GET /health", `status=${res.status}, body=${JSON.stringify(json)}`);
    else pass("GET /health");
  } catch (e) {
    fail("GET /health", e?.message || String(e));
  }

  // 2) Debug version
  try {
    const { res, json } = await reqJson("GET", "/api/debug/version");
    if (!res.ok || json?.ok !== true) fail("GET /api/debug/version", `status=${res.status}, body=${JSON.stringify(json)}`);
    else pass("GET /api/debug/version", `node=${json?.node || "?"}`);
  } catch (e) {
    fail("GET /api/debug/version", e?.message || String(e));
  }

  // 3) Debug knowledge
  try {
    const { res, json } = await reqJson("GET", "/api/debug/knowledge");
    if (!res.ok || json?.ok !== true) fail("GET /api/debug/knowledge", `status=${res.status}, body=${JSON.stringify(json)}`);
    else pass("GET /api/debug/knowledge", `categories=${Object.keys(json?.categories || {}).length}`);
  } catch (e) {
    fail("GET /api/debug/knowledge", e?.message || String(e));
  }

  // 4) Concierge: Ausstattung (Guardrails: keine Links, kein INTERNAL, keine Quellenblöcke)
  try {
    const { res, json } = await reqJson("POST", "/api/concierge", {
      body: {
        lang: "de",
        page: "start",
        sessionId: SESSION_ID,
        message: "Alpenlodge Ausstattung",
      },
    });
    if (!res.ok || typeof json?.reply !== "string") {
      fail("POST /api/concierge (Ausstattung)", `status=${res.status}, body=${JSON.stringify(json)}`);
    } else {
      checkReplyClean("POST /api/concierge (Ausstattung)", json.reply);
      if (Array.isArray(json.links) && json.links.length) {
        fail("POST /api/concierge (Ausstattung)", `sollte keine links[] liefern, bekam: ${JSON.stringify(json.links)}`);
      } else {
        pass("POST /api/concierge (Ausstattung)");
      }

      // Optional stricter check: kein "Offizielle Quellen/Verzeichnisse" Block bei Ausstattung
      if (/offizielle\s+quellen\s*\/\s*verzeichnisse/i.test(json.reply)) {
        warn("POST /api/concierge (Ausstattung)", "Antwort enthält 'Offizielle Quellen/Verzeichnisse' — laut Projektregel nur als Fallback (wenn keine Items)."
        );
      }
    }
  } catch (e) {
    fail("POST /api/concierge (Ausstattung)", e?.message || String(e));
  }

  // 5) Concierge: Skigebiete + Auswahl "2" (List memory)
  try {
    const { res, json } = await reqJson("POST", "/api/concierge", {
      body: {
        lang: "de",
        page: "start",
        sessionId: SESSION_ID,
        message: "Skigebiete im Umkreis 35 km",
      },
    });
    if (!res.ok || typeof json?.reply !== "string") {
      fail("POST /api/concierge (Skigebiete)", `status=${res.status}, body=${JSON.stringify(json)}`);
    } else {
      checkReplyClean("POST /api/concierge (Skigebiete)", json.reply);
      checkLinksArray("POST /api/concierge (Skigebiete)", json.links);
      pass("POST /api/concierge (Skigebiete)", `links=${Array.isArray(json.links) ? json.links.length : 0}`);
    }

    // Follow-up: "2"
    const { res: res2, json: json2 } = await reqJson("POST", "/api/concierge", {
      body: {
        lang: "de",
        page: "start",
        sessionId: SESSION_ID,
        message: "2",
      },
    });
    if (!res2.ok || typeof json2?.reply !== "string") {
      fail("POST /api/concierge (Selektion 2)", `status=${res2.status}, body=${JSON.stringify(json2)}`);
    } else {
      checkReplyClean("POST /api/concierge (Selektion 2)", json2.reply);
      checkLinksArray("POST /api/concierge (Selektion 2)", json2.links);
      pass("POST /api/concierge (Selektion 2)");
    }
  } catch (e) {
    fail("POST /api/concierge (Skigebiete/2)", e?.message || String(e));
  }

  // 6) Booking: über Chat (deterministisch) + actions[]
  try {
    const msg = `Verfügbarkeit ${TEST_ARRIVAL} bis ${TEST_DEPARTURE}`;
    const { res, json } = await reqJson("POST", "/api/concierge", {
      body: {
        lang: "de",
        page: "start",
        sessionId: SESSION_ID,
        message: msg,
      },
    });

    if (!res.ok || typeof json?.reply !== "string") {
      fail("POST /api/concierge (Booking)", `status=${res.status}, body=${JSON.stringify(json)}`);
    } else {
      // Booking replies dürfen Links via actions enthalten. reply selbst sollte trotzdem kein INTERNAL enthalten.
      if (hasInternalMarker(json.reply)) {
        fail("POST /api/concierge (Booking)", "INTERNAL Marker im reply" );
      } else {
        pass("POST /api/concierge (Booking)", `source=${json?.source || "?"}`);
      }
      checkActionsArray("POST /api/concierge (Booking)", json.actions);
    }
  } catch (e) {
    fail("POST /api/concierge (Booking)", e?.message || String(e));
  }

  // 7) Smoobu availability endpoint (direct)
  try {
    const { res, json } = await reqJson("POST", "/api/smoobu/availability", {
      body: { arrivalDate: TEST_ARRIVAL, departureDate: TEST_DEPARTURE, guests: String(TEST_GUESTS) },
    });
    if (!res.ok) {
      fail("POST /api/smoobu/availability", `status=${res.status}, body=${JSON.stringify(json)}`);
    } else {
      const avail = Array.isArray(json?.availableApartments) ? json.availableApartments.length : null;
      pass("POST /api/smoobu/availability", `availableApartments=${avail ?? "?"}`);
      // Offer tokens exist only if BOOKING_TOKEN_SECRET is configured on the server.
      if (Array.isArray(json?.offers) && json.offers.length) {
        pass("offers[]", `offers=${json.offers.length}`);
      } else {
        warn("offers[]", "keine offers[] (BOOKING_TOKEN_SECRET evtl. nicht gesetzt)" );
      }
    }
  } catch (e) {
    fail("POST /api/smoobu/availability", e?.message || String(e));
  }

  // 8) Admin guards (optional)
  // 8a) /api/smoobu/bookings should be forbidden without token
  try {
    const { res } = await reqJson("GET", "/api/smoobu/bookings", {
      query: { from: TEST_ARRIVAL, to: TEST_DEPARTURE, page: 1, pageSize: 1 },
    });
    if (res.status === 403) pass("GET /api/smoobu/bookings (no token)", "forbidden (ok)");
    else warn("GET /api/smoobu/bookings (no token)", `expected 403, got ${res.status}`);
  } catch (e) {
    fail("GET /api/smoobu/bookings (no token)", e?.message || String(e));
  }

  // 8b) /api/smoobu/raw/api/me should be forbidden without token
  try {
    const { res } = await reqJson("GET", "/api/smoobu/raw/api/me");
    if (res.status === 403) pass("GET /api/smoobu/raw/api/me (no token)", "forbidden (ok)");
    else warn("GET /api/smoobu/raw/api/me (no token)", `expected 403, got ${res.status}`);
  } catch (e) {
    fail("GET /api/smoobu/raw/api/me (no token)", e?.message || String(e));
  }

  if (ADMIN_TOKEN) {
    // 8c) /api/smoobu/raw/api/me with token
    try {
      const { res, json } = await reqJson("GET", "/api/smoobu/raw/api/me", {
        headers: { "X-Admin-Token": ADMIN_TOKEN },
      });
      if (!res.ok) fail("GET /api/smoobu/raw/api/me (admin)", `status=${res.status}, body=${JSON.stringify(json)}`);
      else pass("GET /api/smoobu/raw/api/me (admin)");
    } catch (e) {
      fail("GET /api/smoobu/raw/api/me (admin)", e?.message || String(e));
    }
  }

  console.log("\nDone.");
  if (process.exitCode) {
    console.log("\nSmoke Test Ergebnis: NICHT OK (mindestens 1 FAIL/WARN im strict-mode).\n");
  } else {
    console.log("\nSmoke Test Ergebnis: OK.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
