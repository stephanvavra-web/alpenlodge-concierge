// Alpenlodge Concierge – Smoke Test
//
// Updated behavior:
// - Concierge chat is "Auskunft" only by default (booking chat disabled).
// - Booking/availability must be tested via /api/booking/* (or /api/smoobu/*).

import crypto from 'crypto';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const STRICT = process.argv.includes('--strict');
const SESSION_ID = `smoke-${crypto.randomBytes(6).toString('hex')}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function out(label, msg) {
  console.log(`${label}  ${msg}`);
}

async function request(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };

  let body = undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  if (opts.admin) {
    if (ADMIN_TOKEN) headers['X-Admin-Token'] = ADMIN_TOKEN;
  }

  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

let failed = false;
function pass(msg) { out('PASS', msg); }
function fail(msg) { out('FAIL', msg); failed = true; }

(async function main() {
  console.log('\nAlpenlodge Concierge Smoke Test');
  console.log('BASE_URL:   ' + BASE_URL);
  console.log('STRICT:     ' + (STRICT ? 'yes' : 'no'));
  console.log('SESSION_ID: ' + SESSION_ID);
  console.log('ADMIN_TOKEN: ' + (ADMIN_TOKEN ? 'set' : 'not set'));

  // 1) Health
  try {
    const r = await request('/health');
    if (r.status === 200 && r.data && r.data.ok === true) pass('GET /health');
    else fail(`GET /health — status=${r.status}`);
  } catch (e) {
    fail('GET /health — fetch failed');
  }

  // 2) Version
  try {
    const r = await request('/api/debug/version');
    if (r.status === 200 && r.data && r.data.ok) pass(`GET /api/debug/version — node=${r.data.node || '?'}`);
    else fail(`GET /api/debug/version — status=${r.status}`);
  } catch (e) {
    fail('GET /api/debug/version — fetch failed');
  }

  // 3) Knowledge
  try {
    const r = await request('/api/debug/knowledge');
    if (r.status === 200 && r.data && r.data.ok) {
      pass(`GET /api/debug/knowledge — categories=${Object.keys(r.data.categories || {}).length}`);
    } else {
      fail(`GET /api/debug/knowledge — status=${r.status}, body=${JSON.stringify(r.data)}`);
    }
  } catch (e) {
    fail('GET /api/debug/knowledge — fetch failed');
  }

  // 4) Concierge – info question (should work)
  try {
    const r = await request('/api/concierge', {
      method: 'POST',
      json: { lang: 'de', question: 'Welche Ausstattung hat die Alpenlodge?', page: 'start', sessionId: SESSION_ID },
    });
    if (r.status === 200 && typeof r.data?.reply === 'string' && r.data.reply.length > 10) pass('POST /api/concierge (Ausstattung)');
    else fail(`POST /api/concierge (Ausstattung) — status=${r.status}`);
  } catch (e) {
    fail('POST /api/concierge (Ausstattung) — fetch failed');
  }

  // 5) Booking availability (API based)
  // NOTE: This does NOT create a reservation. Safe to run in prod.
  try {
    const r = await request('/api/booking/availability', {
      method: 'POST',
      json: { arrivalDate: '2026-02-01', departureDate: '2026-02-05', guests: 2 },
    });
    const ok = r.status === 200 && Array.isArray(r.data?.availableApartments) && r.data?.prices;
    if (ok) {
      pass(`POST /api/booking/availability — availableApartments=${r.data.availableApartments.length}`);
    } else {
      fail(`POST /api/booking/availability — status=${r.status}, body=${JSON.stringify(r.data)}`);
    }
  } catch (e) {
    fail('POST /api/booking/availability — fetch failed');
  }

  // 6) Admin-protected endpoint
  try {
    const r = await request('/api/smoobu/bookings', { method: 'GET' });
    if (!ADMIN_TOKEN) {
      if (r.status === 403) pass('GET /api/smoobu/bookings (no token) — forbidden (ok)');
      else fail(`GET /api/smoobu/bookings (no token) — expected 403, got ${r.status}`);
    } else {
      if (r.status === 200) pass('GET /api/smoobu/bookings (with token)');
      else fail(`GET /api/smoobu/bookings (with token) — status=${r.status}`);
    }
  } catch (e) {
    fail('GET /api/smoobu/bookings — fetch failed');
  }

  console.log('\nDone.');

  if (failed && STRICT) {
    console.log('\nSmoke Test Ergebnis: NICHT OK (strict-mode).');
    process.exitCode = 1;
  } else {
    console.log('\nSmoke Test Ergebnis: OK.');
    process.exitCode = 0;
  }
})();
