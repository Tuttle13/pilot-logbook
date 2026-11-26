/* Pilot Logbook – iPad web app that stores flights in Home Assistant.
 * Flights are kept on the device (works offline) and synced to
 * /api/pilot_logbook/flights on the HA server it was loaded from.
 *
 * Flight record (Day/Night split matches ZuluLog):
 *   date "YYYY-MM-DD", time "HH:MM", aircraft, type, route, from, to, ifr, vfr, role "SIC"|"PIC",
 *   fltDay, fltNight, aiDay, aiNight, sicDay, sicNight, picDay, picNight
 * plus derived totals kept for exports/totals: total, night, actual, sic, pic. */
'use strict';
const APP_VERSION = '2.2.3';   // keep in step with index.html ?v= and the add-on version

// ---------- field definitions ----------
const SPLITS = [            // [key prefix, label, derived total key]
  ['flt', 'Flt Time', 'total'],
  ['ai', 'Act Inst', 'actual'],
  ['sic', 'SIC Time', 'sic'],
  ['pic', 'PIC Time', 'pic'],
];
const SPLIT_KEYS = SPLITS.flatMap(([p]) => [p + 'Day', p + 'Night']);

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = n => Math.round((n || 0) * 10) / 10;
const r2 = n => Math.round((n || 0) * 100) / 100;
const fmtH = n => (n ? r1(n).toFixed(1) : '');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function localISO(d = new Date()) { return new Date(d - d.getTimezoneOffset() * 6e4).toISOString(); }
const todayLocal = () => localISO().slice(0, 10);
const nowHHMM = () => localISO().slice(11, 16);
// "1.3" -> 1.3, "1:18" -> 1.3, "" -> 0, junk -> NaN
function parseHours(v) {
  v = String(v ?? '').trim(); if (!v) return 0;
  const m = v.match(/^(\d+):(\d{1,2})$/);
  if (m) return r2(+m[1] + +m[2] / 60);
  // "1,654.3" is a thousands separator; a lone comma like "1,3" is a decimal comma.
  v = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v) ? v.replace(/,/g, '') : v.replace(',', '.');
  const n = Number(v);
  return isFinite(n) && n >= 0 ? r2(n) : NaN;
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function routeEnds(route) { const p = String(route || '').trim().split(/[\s\-–>]+/).filter(Boolean); return { from: p[0] || '', to: p.length > 1 ? p[p.length - 1] : '' }; }

// Make split and total fields agree. Splits win; if a record only has totals (old/other imports), split them.
function normalize(f) {
  for (const [p, , tot] of SPLITS) {
    const d = p + 'Day', n = p + 'Night';
    if (f[d] == null && f[n] == null && f[tot]) {
      if (p === 'flt') { f[n] = r2(Math.min(f.night || 0, f[tot])); f[d] = r2(f[tot] - f[n]); }
      else if (r1(f[tot]) === r1(f.total) && f.fltDay != null) { f[d] = f.fltDay; f[n] = f.fltNight; }
      else { f[d] = f[tot]; f[n] = 0; }
    }
    f[d] = r2(f[d]); f[n] = r2(f[n]);
    f[tot] = r2(f[d] + f[n]);
  }
  f.night = f.fltNight;
  const e = routeEnds(f.route); f.from = e.from; f.to = e.to;
  if (!f.role) {
    const pic = f.picDay || f.picNight, sic = f.sicDay || f.sicNight;
    f.role = pic && !sic ? 'PIC' : sic && !pic ? 'SIC' : '';
  }
  return f;
}

// ---------- local data ----------
let flights = store.get('pl.flights', {});      // id -> flight (incl. deleted tombstones)
const saveLocal = () => { if (!store.set('pl.flights', flights)) toast('Could not save on this device — storage is full or blocked.'); };
const live = () => Object.values(flights).filter(f => !f.deleted && !f.kind)   // kind = settings records, not flights
  .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '') || (b.created || 0) - (a.created || 0));
function putFlight(f) { f.updated = Date.now(); f._dirty = true; flights[f.id] = f; saveLocal(); scheduleSync(300); }

// ---------- Home Assistant auth ----------
const BASE = location.pathname.replace(/[^/]*$/, '');           // e.g. /pilot_logbook/
const CLIENT_ID = location.origin + BASE;
const REDIRECT = location.origin + BASE + 'index.html';
let auth = store.get('pl.auth', null);                           // {access, expires, refresh} or {longLived}
// When opened from the "Pilot Log" sidebar panel we're inside Home Assistant's own page,
// which is already logged in - borrow its login instead of signing in again.
function panelAuth() {
  try {
    if (window.parent === window) return null;
    const ha = window.parent.document.querySelector('home-assistant');
    return ha && ha.hass && ha.hass.auth && ha.hass.auth.accessToken ? ha.hass.auth : null;
  } catch { return null; }
}
const signedIn = () => !!(panelAuth() || (auth && (auth.refresh || auth.longLived)));

function startLogin() {
  const state = uid(); store.set('pl.oauthState', state);
  location.href = '/auth/authorize?response_type=code' +
    '&client_id=' + encodeURIComponent(CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(REDIRECT) +
    '&state=' + encodeURIComponent(state);
}
async function tokenRequest(params) {
  const r = await fetchT('/auth/token', { method: 'POST', body: new URLSearchParams(params) });
  if (!r.ok) { const e = new Error('token ' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  auth = { access: j.access_token, expires: Date.now() + (j.expires_in || 1800) * 1000, refresh: j.refresh_token || auth?.refresh };
  store.set('pl.auth', auth);
}
async function handleLoginRedirect() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  if (!code) return;
  history.replaceState(null, '', location.pathname);
  if (p.get('state') !== store.get('pl.oauthState')) { toast('Sign-in was interrupted — please try again.'); return; }
  store.del('pl.oauthState');
  try { await tokenRequest({ grant_type: 'authorization_code', code, client_id: CLIENT_ID }); toast('Signed in to Home Assistant'); }
  catch { toast('Sign-in failed — please try again.'); }
}
async function getToken(force) {
  const pa = panelAuth();
  if (pa) {
    if (force || pa.expired) await pa.refreshAccessToken();
    return pa.accessToken;
  }
  if (!auth) return null;
  if (auth.longLived) return auth.longLived;
  if (!force && auth.access && Date.now() < auth.expires - 60e3) return auth.access;
  try { await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: CLIENT_ID }); }
  catch (e) { if (e.status === 400 || e.status === 403) signOut(true); throw e; }
  return auth.access;
}
function signOut(expired) {
  if (auth?.refresh) fetch('/auth/token', { method: 'POST', body: new URLSearchParams({ action: 'revoke', token: auth.refresh }) }).catch(() => {});
  auth = null; store.del('pl.auth');
  setSync(expired ? 'bad' : '', expired ? 'Sign in again' : 'Not signed in');
  renderSettings();
}
// fetch that gives up instead of hanging (Wi-Fi with no real internet can leave requests open forever)
function netErr() { const e = new Error('no connection'); e.offline = true; return e; }
async function fetchT(url, opts = {}, ms = 15000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) { throw netErr(); }
  finally { clearTimeout(timer); }
}
async function api(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await getToken(attempt > 0);
    if (!tok) throw new Error('not signed in');
    const r = await fetchT('/api/pilot_logbook/' + path, {
      method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, body ? 30000 : 15000);
    // In-flight / hotel Wi-Fi login pages and Cloudflare error pages come back as HTML: treat as "no connection".
    if ((r.headers.get('content-type') || '').includes('text/html')) throw netErr();
    if (r.status === 401 && attempt === 0 && !auth?.longLived) continue;
    if (r.status === 401) { if (!panelAuth()) signOut(true); throw new Error('unauthorized'); }
    if (r.status === 404) throw new Error('Pilot Logbook integration not found on Home Assistant');
    if (!r.ok) throw new Error('server ' + r.status);
    return r.json();
  }
}

// ---------- sync ----------
let syncing = false, syncTimer = null;
function setSync(cls, text) {
  $('#syncDot').className = 'dot ' + cls; $('#syncText').textContent = text;
  $('#syncBtn').classList.toggle('busy', cls === 'busy'); $('#syncBtn').title = text;
}
function pendingCount() { return Object.values(flights).filter(f => f._dirty).length; }
const DEVICE = /Android/i.test(navigator.userAgent) ? 'phone' : /iPad|Macintosh/.test(navigator.userAgent) ? 'iPad' : 'this device';
function savedOnDevice() { const p = pendingCount(); return p ? `Saved on ${DEVICE} · ${p} to sync later` : `Saved on ${DEVICE}`; }
function scheduleSync(ms = 0) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }

// Wi-Fi that has no internet (e.g. the onboard crew network) can't be told apart from real internet by a web
// app, so before syncing ask the server for a tiny reply. No answer within a few seconds = no internet: stay quiet,
// keep the flights on the device, and look again shortly (it syncs by itself once you're back on 4G).
const PROBE_MS = 4000;
function giveUpAfter(ms, p) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(netErr()), ms))]); }
async function serverReachable() {
  try {
    const tok = await giveUpAfter(PROBE_MS, getToken());
    if (!tok) return true;                                   // not signed in: let sync() report that
    const r = await fetchT('/api/', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' }, PROBE_MS);
    if (r.status === 401) return true;                       // reached Home Assistant; sync() refreshes the sign-in
    return r.ok && (r.headers.get('content-type') || '').includes('json');   // Wi-Fi login pages come back as HTML
  } catch (e) {
    if (e.offline || !e.status) return false;
    return true;                                             // a real answer from the server (e.g. sign-in refused)
  }
}
async function sync(manual) {
  if (syncing) return scheduleSync(2000);
  if (!signedIn()) { setSync(pendingCount() ? 'warn' : '', 'Not signed in'); return; }
  if (!navigator.onLine) { setSync('', savedOnDevice()); if (manual === true) toast('No internet. Your flights are saved and will sync when you\'re back online.', 3500); return; }
  syncing = true;
  if (!(await serverReachable())) {
    syncing = false;
    setSync('', savedOnDevice());
    if (manual === true) toast('No internet on this connection. Your flights are saved and will sync when you\'re back online.', 4000);
    return;
  }
  let pushed = 0;
  try {
    const dirty = Object.values(flights).filter(x => x._dirty);
    for (let i = 0; i < dirty.length; i += 250) {                 // upload in batches (fast for big imports)
      setSync('busy', dirty.length > 250 ? `Uploading ${i}/${dirty.length}…` : 'Syncing…');
      const chunk = dirty.slice(i, i + 250).map(({ _dirty, ...clean }) => clean);
      const res = await api('POST', 'flights', { flights: chunk });
      for (const r of res.results) {
        const sent = chunk.find(c => c.id === r.id), cur = flights[r.id];
        if (sent && cur && cur.updated === sent.updated) flights[r.id] = r.accepted ? sent : r.flight;   // not edited meanwhile
      }
      pushed += chunk.length; saveLocal();
    }
    setSync('busy', 'Syncing…');
    const res = await api('GET', 'flights');
    let changed = pushed > 0;
    for (const s of res.flights) {
      const l = flights[s.id];
      if (!l || (!l._dirty && (s.updated || 0) > (l.updated || 0))) { flights[s.id] = s; changed = true; }
    }
    saveLocal();
    store.set('pl.lastSync', Date.now());
    const p = pendingCount();
    setSync(p ? 'warn' : 'ok', p ? `${p} to sync` : 'Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    if (changed) refreshAll();
    if (pushed) setTimeout(() => refreshCasa(true), 8000);   // the server rebuilds the CASA workbook a few seconds after changes
  } catch (e) {
    // No connection (airplane mode, in-flight Wi-Fi): not an error - flights are safe on the iPad and sync later.
    if (e.offline || e instanceof SyntaxError) setSync('', savedOnDevice());
    else setSync(signedIn() ? 'bad' : '', signedIn() ? `Sync failed · ${pendingCount()} waiting` : 'Sign in again');
    console.warn('sync', e);
    if (/not found/.test(e.message)) toast(e.message, 5000);
    if (pushed) refreshAll();
  } finally {
    syncing = false; renderSettings();
  }
}

// ---------- entry form ----------
const form = $('#form');
let editingId = null, formDirty = false, formError = '';
const fld = n => form.elements.namedItem(n);

function buildForm() {
  // Flt Time and Act Inst on the main page; SIC / PIC Time (filled automatically) live under More fields.
  const row = ([p, label]) => `
    <div class="trow" data-row="${p}">
      <span class="fl">${label}</span>
      ${['Day', 'Night'].map(dn => `
        <span class="step">
          <input name="${p}${dn}" inputmode="decimal" placeholder="${dn}" aria-label="${label} ${dn.toLowerCase()}">
          <button type="button" data-step="${p}${dn}" data-d="-0.1" aria-label="minus 0.1">−</button>
          <button type="button" data-step="${p}${dn}" data-d="0.1" aria-label="plus 0.1">+</button>
        </span>`).join('')}
      <span class="rtot" id="tot-${p}"></span>
    </div>`;
  $('#timeRows').innerHTML = SPLITS.filter(([p]) => p === 'flt' || p === 'ai').map(row).join('');
  $('#crewRows').innerHTML = SPLITS.filter(([p]) => p === 'sic' || p === 'pic').map(row).join('');
  // SIC / PIC Time are filled from Flt Time automatically, so they're display-only.
  $$('#crewRows input').forEach(i => { i.readOnly = true; i.tabIndex = -1; });
  $$('#crewRows button[data-step]').forEach(b => { b.disabled = true; });
}
// New flights start with the Rules and Role you used last time (IFR / SIC if none yet).
function blankFlight() {
  const last = store.get('pl.lastChoice', { rules: 'IFR', role: 'SIC' });
  return {
    id: uid(), created: Date.now(), date: todayLocal(), time: nowHHMM(), role: last.role === 'PIC' ? 'PIC' : 'SIC',
    ifr: last.rules !== 'VFR', vfr: last.rules === 'VFR',
  };
}

// ---------- aircraft type from tail rego ----------
const CFG_TAILS = 'cfg-tailtypes';   // synced settings record: tail -> type chosen by the user
const tailOverrides = () => (flights[CFG_TAILS] && !flights[CFG_TAILS].deleted && flights[CFG_TAILS].map) || {};
// Fleet rules: 737-700 / 737-800 / MAX 8 by tail.
function tailRuleType(tail) {
  const t = String(tail || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{3}$/.test(t)) return '';
  const between = (a, b) => t >= a && t <= b;
  if (t === 'VBY' || t === 'VBZ' || between('NBP', 'NVW')) return 'B737';
  if (t === 'REX' || t === 'RQP' || /^(VO|VU|YF|YQ|YW|YI|YV)/.test(t) || between('IJQ', 'IXK')) return 'B738';
  if (t[0] === '8') return 'B38M';   // 8IA-8IH, 8II-8IP, 8VA-8VF, 8VG-8VK and any other 8xx
  return '';
}
function typeForTail(tail) {
  const t = String(tail || '').toUpperCase().trim();
  if (!t) return '';
  return tailOverrides()[t] || tailRuleType(t) || (live().find(x => x.aircraft === t && x.type) || {}).type || '';
}
function setTailOverride(tail, type) {
  const cur = flights[CFG_TAILS] && !flights[CFG_TAILS].deleted ? flights[CFG_TAILS] : { id: CFG_TAILS, kind: 'config', created: Date.now(), map: {} };
  putFlight({ ...cur, map: { ...cur.map, [tail]: type } });
}
// Change many flights at once (one save to the iPad, then one sync).
function bulkUpdate(changes) {
  const now = Date.now();
  for (const [f, patch] of changes) flights[f.id] = { ...f, ...patch, updated: now, _dirty: true };
  if (changes.length) { saveLocal(); refreshAll(); scheduleSync(300); }
}

// ---------- grey suggestions (double-tap to use) ----------
// Suggestions only come from a flight on the SAME calendar day as the one being entered:
// the flight you saved most recently if it's that day, otherwise that day's latest flight.
// The first entry of a day gets no suggestions.
function suggestionSource(date) {
  if (!date) return null;
  const last = flights[store.get('pl.lastSaved', '')];
  if (last && !last.deleted && !last.kind && last.date === date && last.id !== editingId) return last;
  return live().find(f => f.date === date && f.id !== editingId) || null;
}
const reverseRoute = r => String(r || '').trim().split(/\s+/).filter(Boolean).reverse().join(' ');
let suggestOn = false;   // only for new entries, not when editing an existing flight
function setSuggestions(isNew) {
  if (isNew !== undefined) suggestOn = !!isNew;
  const src = suggestOn ? suggestionSource(fld('date').value) : null;
  const ac = src && src.aircraft ? src.aircraft : '', rt = src && src.route ? reverseRoute(src.route) : '';
  fld('aircraft').placeholder = ac; fld('aircraft').dataset.sugg = ac;
  fld('route').placeholder = rt; fld('route').dataset.sugg = rt;
}
function acceptSuggestion(input) {
  if (input.value.trim() || !input.dataset.sugg) return;
  input.value = input.dataset.sugg;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function updateRowTotals() {
  for (const [p] of SPLITS) {
    const t = (parseHours(fld(p + 'Day').value) || 0) + (parseHours(fld(p + 'Night').value) || 0);
    $('#tot-' + p).textContent = t ? r1(t).toFixed(1) : '';
  }
}
function updateRowVisibility() {
  const role = fld('role').value;
  const has = p => fld(p + 'Day').value.trim() || fld(p + 'Night').value.trim();
  $('[data-row="sic"]').hidden = !(role === 'SIC' || has('sic'));
  $('[data-row="pic"]').hidden = !(role === 'PIC' || has('pic'));
}
// SIC or PIC Time (whichever the role is) always follows Flt Time.
function mirrorSic() {
  const p = fld('role').value === 'PIC' ? 'pic' : 'sic';
  fld(p + 'Day').value = fld('fltDay').value;
  fld(p + 'Night').value = fld('fltNight').value;
  // SE/ME (when filled in) also follow the total flight time.
  const tot = (parseHours(fld('fltDay').value) || 0) + (parseHours(fld('fltNight').value) || 0);
  for (const k of ['me', 'se']) if (fld(k).value.trim()) { fld(k).value = fmtH(tot) || '0.0'; break; }
}
const MORE_NUM = ['se', 'me', 'simInst'], MORE_TXT = ['picName', 'sicName'];
function fillForm(f) {
  for (const k of ['date', 'time', 'aircraft', 'type', 'route']) fld(k).value = f[k] ?? '';
  fld('role').value = f.role === 'PIC' ? 'PIC' : 'SIC';
  fld('rules').value = f.vfr && !f.ifr ? 'VFR' : 'IFR';
  for (const k of SPLIT_KEYS) fld(k).value = f[k] ? fmtH(f[k]) : '';
  for (const k of MORE_NUM) fld(k).value = f[k] ? fmtH(f[k]) : '';
  for (const k of MORE_TXT) fld(k).value = f[k] || '';
  const filled = [...MORE_NUM, ...MORE_TXT].filter(k => f[k]).length;
  $('#moreHint').textContent = filled ? `(${filled} filled in)` : '';
  $$('input.bad', form).forEach(i => i.classList.remove('bad'));
  updateRowTotals(); updateRowVisibility();
  formDirty = false;
}
function readForm() {
  const f = { ...(flights[editingId] || {}) };
  delete f._dirty;
  let ok = true;
  f.date = fld('date').value; f.time = fld('time').value;
  for (const k of ['aircraft', 'type', 'route']) f[k] = fld(k).value.trim().toUpperCase().replace(/\s+/g, ' ');
  f.role = fld('role').value; f.ifr = fld('rules').value === 'IFR'; f.vfr = fld('rules').value === 'VFR';
  for (const k of SPLIT_KEYS) {
    const v = parseHours(fld(k).value), bad = isNaN(v);
    fld(k).classList.toggle('bad', bad); if (bad) ok = false;
    f[k] = bad ? 0 : v;
  }
  // Safeguard: your crew time always equals the flight time for the role you picked.
  if (ok) {
    const own = f.role === 'PIC' ? 'pic' : 'sic', other = own === 'pic' ? 'sic' : 'pic';
    f[own + 'Day'] = f.fltDay; f[own + 'Night'] = f.fltNight;
    f[other + 'Day'] = 0; f[other + 'Night'] = 0;
  }
  // Safeguard: every flight gets an aircraft type (from your per-tail choice, the fleet rules or history).
  if (f.aircraft && !f.type) { f.type = typeForTail(f.aircraft); fld('type').value = f.type; }
  const typeOk = !f.aircraft || /^[A-Z0-9]{3,4}$/.test(f.type || '');
  fld('type').classList.toggle('bad', !typeOk);
  formError = typeOk ? '' : `Enter the aircraft type for ${f.aircraft} (3–4 letters/numbers, e.g. B738).`;
  if (!typeOk) ok = false;
  for (const [p, , tot] of SPLITS) delete f[tot];   // recomputed from splits
  for (const k of MORE_NUM) {
    const raw = fld(k).value.trim(), v = parseHours(raw), bad = isNaN(v);
    fld(k).classList.toggle('bad', bad); if (bad) ok = false;
    if (raw === '' || bad) delete f[k]; else f[k] = v;
  }
  for (const k of MORE_TXT) { const v = fld(k).value.trim(); if (v) f[k] = v; else delete f[k]; }
  fld('date').classList.toggle('bad', !f.date); if (!f.date) ok = false;
  f.id = editingId; f.created = f.created || Date.now();
  if (!ok) { if ($('.bad', $('#moreFields'))) $('#moreFields').open = true; return null; }
  normalize(f);
  // If SE and ME were left blank, fill one from the aircraft type's earlier flights (e.g. B738 -> ME).
  if (f.se == null && f.me == null) {
    const prev = f.type && live().find(x => x.id !== f.id && x.type === f.type && (x.me || x.se));
    if (prev && f.total) { if (prev.me) f.me = f.total; else f.se = f.total; }
  }
  return f;
}
function openEditor(f, isNew) {
  if (!confirmDiscard()) return false;
  editingId = f.id;
  fillForm(f);
  setSuggestions(!!isNew);
  $('#viewTitle').textContent = isNew ? 'Enter Flight' : 'Edit Flight';
  $('#delBar').hidden = !!isNew;
  form.hidden = false;
  $('.split').classList.add('editing');
  document.body.classList.add('editing');
  $('#searchBtn').hidden = true; $('#menu').hidden = true;
  $('#editpane').scrollTop = 0;
  return true;
}
function closeEditor() {
  editingId = null; form.hidden = true; formDirty = false;
  $('.split').classList.remove('editing');
  document.body.classList.remove('editing');
  $('#viewTitle').textContent = 'Pilot Logbook';
  $('#searchBtn').hidden = $('#view-log').hidden;
}
function confirmDiscard() { return !formDirty || confirm('Discard your unsaved changes to this flight?'); }

function save(next) {
  const f = readForm();
  if (!f) { toast(formError || 'Please fix the highlighted fields.', 4500); return; }
  const wasNew = !flights[f.id];
  putFlight(f); formDirty = false;
  store.set('pl.lastChoice', { rules: f.vfr && !f.ifr ? 'VFR' : 'IFR', role: f.role });
  store.set('pl.lastSaved', f.id);
  refreshAll();
  toast(wasNew ? 'Flight saved' : 'Flight updated');
  if (next === 'leg') {
    const n = blankFlight();
    n.date = f.date;                 // aircraft and route are offered as grey suggestions
    openEditor(n, true);
  } else closeEditor();
}

function wireForm() {
  form.addEventListener('input', e => {
    formDirty = true;
    const n = e.target.name;
    if (n === 'fltDay' || n === 'fltNight') mirrorSic();
    if (SPLIT_KEYS.includes(n)) updateRowTotals();
  });
  form.addEventListener('change', e => {
    const t = e.target;
    if (t.name === 'date') setSuggestions();         // changing the date changes which day's flights are suggested
    if (t.name === 'aircraft') {                    // fill the type from your choice for this tail, the fleet rules, or history
      t.value = t.value.trim().toUpperCase();
      if (t.value) { const ty = typeForTail(t.value); if (ty) fld('type').value = ty; }
    }
    if (t.name === 'type') {
      const ty = t.value.trim().toUpperCase(), ac = fld('aircraft').value.trim().toUpperCase();
      t.value = ty;
      const ok = !ty || /^[A-Z0-9]{3,4}$/.test(ty);
      t.classList.toggle('bad', !ok);
      if (!ok) { toast('Aircraft type should be 3 or 4 letters/numbers, e.g. B738.'); return; }
      if (ty && ac && ty !== typeForTail(ac)) {
        const others = live().filter(x => x.aircraft === ac && x.id !== editingId && x.type !== ty);
        if (confirm(`Use ${ty} for ${ac} from now on?` + (others.length ? `\n\nThis also changes the type on your ${others.length} other ${ac} flight${others.length === 1 ? '' : 's'}.` : ''))) {
          setTailOverride(ac, ty);
          bulkUpdate(others.map(x => [x, { type: ty }]));
          toast(`${ac} set to ${ty}` + (others.length ? ` on ${others.length + 1} flights` : ''));
        }
      }
    }
    if (t.name === 'role') {
      const other = t.value === 'PIC' ? 'sic' : 'pic';
      fld(other + 'Day').value = ''; fld(other + 'Night').value = '';
      mirrorSic();
      updateRowTotals(); updateRowVisibility();
    }
    if (SPLIT_KEYS.includes(t.name)) { const v = parseHours(t.value); if (!isNaN(v)) t.value = fmtH(v); }
  });
  form.addEventListener('click', e => {
    const b = e.target.closest('button[data-step]'); if (!b) return;
    const i = fld(b.dataset.step);
    const v = Math.max(0, r1((parseHours(i.value) || 0) + +b.dataset.d));
    i.value = v ? v.toFixed(1) : '';
    formDirty = true;
    if (b.dataset.step.startsWith('flt')) mirrorSic();
    updateRowTotals();
  });
  // Double-tap a grey suggestion (Aircraft ID / Route) to use it. A single tap just lets you type.
  for (const name of ['aircraft', 'route']) {
    const inp = fld(name); let lastTap = 0;
    inp.addEventListener('pointerup', () => {
      const now = Date.now();
      if (now - lastTap < 400) { acceptSuggestion(inp); lastTap = 0; } else lastTap = now;
    });
    inp.addEventListener('dblclick', () => acceptSuggestion(inp));
  }
  form.addEventListener('submit', e => { e.preventDefault(); save(); });
  $('#delBtn').onclick = () => {
    const f = flights[editingId]; if (!f) return;
    if (!confirm(`Delete the ${f.date} ${f.route || ''} flight? It will be removed from Home Assistant too.`)) return;
    putFlight({ id: f.id, created: f.created, deleted: true });
    formDirty = false; closeEditor(); refreshAll(); toast('Flight deleted');
  };
}

// ---------- list ----------
let listLimit = 300;
function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const all = live();
  $('#recCount').textContent = all.length;
  const rows = q ? all.filter(f => [f.date, f.aircraft, f.type, f.route, f.role].some(v => String(v || '').toLowerCase().includes(q))) : all;
  if (!rows.length) {
    $('#list').innerHTML = `<div class="listempty">${all.length ? 'No flights match your search.' : 'No flights yet.<br>Import your ZuluLog logbook from Settings, or tap <b>+</b> to log a flight.'}</div>`;
    return;
  }
  const SYNC_IC = '<svg viewBox="0 0 24 24" aria-label="Not synced yet"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/></svg>';
  const html = rows.slice(0, listLimit).map(f => {
    const d = f.date ? new Date(f.date + 'T12:00') : null;
    const ai = r1(f.actual), tot = r1(f.total);
    const nightPct = tot ? Math.min(100, Math.round((f.night || 0) / tot * 100)) : 0;   // dark part of the square = night share
    return `<div class="item" data-id="${esc(f.id)}">
      <div class="s">${f._dirty ? SYNC_IC : ''}</div>
      <div class="d"><b>${d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '–'}</b><span>${d ? d.getFullYear() + ' ' + d.toLocaleDateString('en-US', { weekday: 'short' }) : ''}</span></div>
      <div class="t"><span class="sq"><i style="height:${nightPct}%"></i></span>${tot.toFixed(1)}</div>
      <div class="ac"><b>${esc(f.type || '--')}</b><span>${esc(f.aircraft || '--')}</span></div>
      <div class="rt"><b>${esc(f.route || '--')}</b><span>--</span></div>
      <div class="rl"><b>${esc(f.role || '--')}</b><span>--</span></div>
      <div class="x"><b>&nbsp;</b><span>${ai ? 'AI:' + ai.toFixed(1) : '&nbsp;'}</span></div>
    </div>`;
  }).join('') + (rows.length > listLimit ? `<button type="button" class="btn more" id="moreBtn">Show more (${rows.length - listLimit} older)</button>` : '');
  $('#list').innerHTML = html;
}

function renderDatalists() {
  const all = live(), uniq = a => [...new Set(a.filter(Boolean))].slice(0, 300);
  const opts = a => uniq(a).map(v => `<option value="${esc(v)}">`).join('');
  $('#dl-aircraft').innerHTML = opts(all.map(f => f.aircraft));
  $('#dl-type').innerHTML = opts(all.map(f => f.type));
  $('#dl-route').innerHTML = opts(all.map(f => f.route));
  $('#dl-names').innerHTML = opts(all.flatMap(f => [f.picName, f.sicName]));
}

// ---------- totals ----------
const TOT_COLS = [['total', 'Flt Time'], ['fltDay', 'Day'], ['night', 'Night'], ['sic', 'SIC'], ['pic', 'PIC'], ['actual', 'Act Inst'], ['se', 'SE'], ['me', 'ME'], ['ifrN', 'IFR flights'], ['flights', 'Flights']];
function sumFlights(list) {
  const s = { flights: list.length, ifrN: 0 };
  for (const [k] of TOT_COLS) if (!(k in s)) s[k] = 0;
  for (const f of list) {
    for (const k of ['total', 'fltDay', 'night', 'sic', 'pic', 'actual', 'se', 'me']) s[k] += f[k] || 0;
    if (f.ifr) s.ifrN++;
  }
  return s;
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return localISO(d).slice(0, 10); }
function renderTotals() {
  const all = live();
  const periods = [['All time', all], ['Last 7 days', all.filter(f => f.date > daysAgo(7))], ['Last 28 days', all.filter(f => f.date > daysAgo(28))], ['Last 90 days', all.filter(f => f.date > daysAgo(90))],
    ['Last 365 days', all.filter(f => f.date > daysAgo(365))], ['This year', all.filter(f => (f.date || '').startsWith(String(new Date().getFullYear())))]];
  const cell = (s, k) => ['ifrN', 'flights'].includes(k) ? (s[k] || '–') : (s[k] ? r1(s[k]).toFixed(1) : '–');
  $('#totalsTbl').innerHTML = `<thead><tr><th></th>${TOT_COLS.map(c => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>` +
    periods.map(([n, l]) => { const s = sumFlights(l); return `<tr><td><b>${n}</b></td>${TOT_COLS.map(([k]) => `<td>${cell(s, k)}</td>`).join('')}</tr>`; }).join('') + '</tbody>';
  const byType = {};
  for (const f of all) (byType[f.type || '(no type)'] ||= []).push(f);
  const trows = Object.entries(byType).map(([t, l]) => [t, sumFlights(l)]).sort((a, b) => b[1].total - a[1].total);
  $('#typeTbl').innerHTML = `<thead><tr><th>Type</th>${TOT_COLS.map(c => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>` +
    (trows.length ? trows.map(([t, s]) => `<tr><td><b>${esc(t)}</b></td>${TOT_COLS.map(([k]) => `<td>${cell(s, k)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${TOT_COLS.length + 1}" class="muted">No flights yet.</td></tr>`) + '</tbody>';
}

// ---------- settings / data ----------
function renderSettings() {
  try { refreshCasa(); } catch (e) { console.warn('casa', e); }
  const ls = store.get('pl.lastSync', 0), inPanel = !!panelAuth();
  const last = ls ? ' Last sync ' + new Date(ls).toLocaleString() + '.' : '';
  $('#authState').textContent = inPanel
    ? `Using your Home Assistant login.${last}`
    : signedIn()
      ? `Connected to ${location.host}${auth.longLived ? ' (long-lived token)' : ''}.${last}`
      : `Not signed in. Flights are only saved on this device until you sign in to ${location.host}.`;
  $('#signInBtn').hidden = signedIn();
  $('#signOutBtn').hidden = !signedIn() || inPanel;
  $('details', $('#signInBtn').closest('.card')).hidden = inPanel;
  $('#syncNowBtn').hidden = !signedIn();
  const n = live().length, p = pendingCount();
  $('#dataState').textContent = `${n} flight${n === 1 ? '' : 's'} on this device${p ? `, ${p} waiting to sync` : ', all synced'}.`;
}
const CSV_COLS = [['date', 'Date'], ['time', 'Time'], ['aircraft', 'Aircraft ID'], ['type', 'Aircraft Type'], ['route', 'Route'], ['ifr', 'IFR'], ['vfr', 'VFR'], ['role', 'Role'],
  ['fltDay', 'Day Flt Time'], ['fltNight', 'Night Flt Time'], ['total', 'Total Flt Time'], ['aiDay', 'Day Act Inst'], ['aiNight', 'Night Act Inst'],
  ['sicDay', 'Day SIC Time'], ['sicNight', 'Night SIC Time'], ['picDay', 'Day PIC Time'], ['picNight', 'Night PIC Time'],
  ['se', 'SE'], ['me', 'ME'], ['simInst', 'Sim Inst'], ['picName', 'PIC Name'], ['sicName', 'SIC Name'], ['remarks', 'Remarks']];
function exportCsv() {
  const q = v => { v = v == null ? '' : typeof v === 'boolean' ? (v ? 'Y' : '') : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [CSV_COLS.map(c => c[1]).join(',')];
  for (const f of live().reverse()) lines.push(CSV_COLS.map(([k]) => q(f[k] === 0 ? '' : f[k])).join(','));
  download(`logbook-${todayLocal()}.csv`, lines.join('\r\n'), 'text/csv');
}
function exportJson() {
  download(`logbook-backup-${todayLocal()}.json`, JSON.stringify({ app: 'pilot_logbook', version: 2, exported: new Date().toISOString(), flights: live().map(({ _dirty, ...f }) => f) }, null, 1), 'application/json');
}
async function importJson(file) {
  try {
    const j = JSON.parse(await file.text());
    const list = Array.isArray(j) ? j : j.flights;
    if (!Array.isArray(list)) throw new Error('no flights');
    let added = 0;
    for (const f of list) {
      if (!f || typeof f !== 'object' || !f.date) continue;
      const id = /^[A-Za-z0-9_-]{8,64}$/.test(f.id || '') ? f.id : uid();
      if (flights[id] && !flights[id].deleted) continue;          // keep existing copy
      flights[id] = normalize({ ...f, id, created: f.created || Date.now(), updated: Date.now(), _dirty: true }); added++;
    }
    saveLocal(); refreshAll(); scheduleSync();
    toast(`Restored ${added} flight${added === 1 ? '' : 's'}.`);
  } catch { toast('That file is not a Pilot Logbook backup.'); }
}

// ---------- CSV import (ZuluLog Web export or any other logbook) ----------
const IMPORT_TARGETS = [
  ['', '— ignore —'],
  ['date', 'Flt Date (and time)'], ['time', 'Time of day'], ['aircraft', 'Aircraft ID'], ['type', 'Aircraft type'],
  ['route', 'Route'], ['from', 'From'], ['to', 'To'], ['role', 'Role'], ['ifr', 'IFR (yes/no)'], ['vfr', 'VFR (yes/no)'],
  ['fltDay', 'Flt Time – day'], ['fltNight', 'Flt Time – night'], ['total', 'Flt Time – total'], ['night', 'Night time (total)'],
  ['aiDay', 'Act Inst – day'], ['aiNight', 'Act Inst – night'], ['actual', 'Act Inst – total'],
  ['sicDay', 'SIC Time – day'], ['sicNight', 'SIC Time – night'], ['sic', 'SIC Time – total'],
  ['picDay', 'PIC Time – day'], ['picNight', 'PIC Time – night'], ['pic', 'PIC Time – total'],
  ['se', 'Single-engine time'], ['me', 'Multi-engine time'], ['simInst', 'Sim Inst'],
  ['picName', 'PIC name (kept, not shown)'], ['sicName', 'SIC name (kept, not shown)'],
  ['remarks', 'Remarks (kept, not shown)'],
];
const HOUR_TARGETS = new Set(['fltDay', 'fltNight', 'total', 'night', 'aiDay', 'aiNight', 'actual', 'sicDay', 'sicNight', 'sic', 'picDay', 'picNight', 'pic', 'se', 'me', 'simInst']);
function guessTarget(header) {
  const h = header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dn = (day, night, tot) => /\bnight\b/.test(h) ? night : /\bday\b/.test(h) ? day : tot;
  if (/\bdate\b/.test(h) && !/added|modified|created|expir|sync/.test(h)) return 'date';
  if (/aircraft id|registration|^rego?\b|^tail|^ident|^aircraft$/.test(h)) return 'aircraft';
  if (/aircraft type|^type$|^ac type|make|model/.test(h)) return 'type';
  if (/route/.test(h)) return 'route';
  if (/^from$|^dep(arture)?( airport| point)?$|^origin/.test(h)) return 'from';
  if (/^to$|^dest|^arr(ival)?( airport| point)?$/.test(h)) return 'to';
  if (/role/.test(h)) return 'role';
  if (/^ifr$/.test(h)) return 'ifr';
  if (/^vfr$/.test(h)) return 'vfr';
  if (/^se$|single ?engine/.test(h)) return 'se';
  if (/^me$|multi ?engine/.test(h)) return 'me';
  if (/sim(ulated)? inst|hood/.test(h)) return 'simInst';
  if (/\bpic\b.*name|captain name/.test(h)) return 'picName';
  if (/\bsic\b.*name|f ?o name|co ?pilot name/.test(h)) return 'sicName';
  if (/\bsic\b|co ?pilot/.test(h)) return dn('sicDay', 'sicNight', 'sic');
  if (/\bpic\b|captain/.test(h) && !/name|ccy|currency|picus/.test(h)) return dn('picDay', 'picNight', 'pic');
  if (/act(ual)? inst|^ai$|\bimc\b/.test(h)) return dn('aiDay', 'aiNight', 'actual');
  if (/fl(igh)?t time|^total( time| flight time| flt time)?$|block time/.test(h)) return dn('fltDay', 'fltNight', 'total');
  if (/^night( time)?$/.test(h)) return 'night';
  if (/^time$|time of day|dep(arture)? time/.test(h)) return 'time';
  if (/remark|comment|note/.test(h)) return 'remarks';
  return '';
}
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function detectDateFmt(values) {
  let mdy = 0, dmy = 0, ymd = 0;
  for (const v of values) {
    const s = v.trim();
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s)) { ymd++; continue; }
    const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
    if (m) { if (+m[1] > 12) dmy++; else if (+m[2] > 12) mdy++; }
  }
  return ymd ? 'ymd' : dmy > mdy ? 'dmy' : mdy > dmy ? 'mdy' : 'dmy';
}
function parseDate(v, fmt) {
  const s = String(v || '').trim(); if (!s) return '';
  const pad = n => String(n).padStart(2, '0');
  const ok = (y, m, d) => (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${pad(m)}-${pad(d)}` : '';
  const yy = y => (y < 100 ? y + (y < 70 ? 2000 : 1900) : y);
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/. ]?([A-Za-z]{3})[a-z]*[-/. ,]*(\d{2,4})/);            // 19Nov2026, 19-Nov-26, 19 November 2026
  if (m && MONTHS.includes(m[2].toLowerCase())) return ok(yy(+m[3]), MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  m = s.match(/^([A-Za-z]{3})[a-z]*[-/. ]?(\d{1,2})[-/. ,]+(\d{2,4})/);           // Nov 19, 2026
  if (m && MONTHS.includes(m[1].toLowerCase())) return ok(yy(+m[3]), MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) return fmt === 'mdy' ? ok(yy(+m[3]), +m[1], +m[2]) : ok(yy(+m[3]), +m[2], +m[1]);
  return '';
}
const timeIn = v => { const m = String(v || '').match(/(?:^|\D)(\d{1,2}):?(\d{2})(?::\d{2})?\s*$/); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
const truthy = v => /^(1|y|yes|true|x|✓|✔|on|t)$/i.test(String(v).trim()) || parseFloat(v) > 0;

let imp = null;   // { name, header, rows, map[] }
function startCsvImport(file) {
  file.text().then(text => {
    const rows = parseCsv(text);
    if (rows.length < 2) { toast('That file has no flight rows.'); return; }
    const header = rows[0].map(h => h.trim());
    imp = { name: file.name, header, rows: rows.slice(1), map: header.map(guessTarget) };
    const di = imp.map.indexOf('date');
    $('#impDateFmt').value = 'auto';
    imp.autoFmt = di >= 0 ? detectDateFmt(imp.rows.slice(0, 500).map(r => r[di] || '')) : 'dmy';
    $('#impTitle').textContent = `Import ${imp.rows.length} rows from ${file.name}`;
    renderImport(); show('import');
  }).catch(() => toast('Could not read that file.'));
}
function importFlights() {
  const fmt = $('#impDateFmt').value === 'auto' ? imp.autoFmt : $('#impDateFmt').value;
  const out = [];
  for (const r of imp.rows) {
    const f = {}; let from = '', to = '';
    imp.map.forEach((t, i) => {
      if (!t) return;
      const v = (r[i] ?? '').trim(); if (v === '') return;
      if (t === 'date') { f.date = parseDate(v, fmt); const tm = v.match(/(\d{1,2}):(\d{2})/); if (tm && !f.time && +tm[1] < 24) f.time = tm[1].padStart(2, '0') + ':' + tm[2]; }
      else if (t === 'time') f.time = timeIn(v) || f.time;
      else if (HOUR_TARGETS.has(t)) { const h = parseHours(v); if (!isNaN(h)) f[t] = r2((f[t] || 0) + h); }
      else if (t === 'ifr' || t === 'vfr') f[t] = truthy(v);
      else if (t === 'role') { const u = v.toUpperCase(); f.role = /SIC|F\/?O|FIRST|CO/.test(u) ? 'SIC' : /PIC|CAPT|CAPTAIN|CMD/.test(u) ? 'PIC' : u; }
      else if (t === 'from') from = v.toUpperCase();
      else if (t === 'to') to = v.toUpperCase();
      else if (t === 'aircraft' || t === 'type' || t === 'route') f[t] = (f[t] ? f[t] + ' ' : '') + v.toUpperCase().replace(/\s+/g, ' ');
      else f[t] = f[t] ? f[t] + '; ' + v : v;
    });
    if (!f.route && (from || to)) f.route = [from, to].filter(Boolean).join(' ');
    if (f.aircraft) {                                            // your per-tail choice / fleet rules win over the file's type
      const tail = f.aircraft.toUpperCase().trim(), ruled = tailOverrides()[tail] || tailRuleType(tail);
      if (ruled) f.type = ruled; else if (!f.type) f.type = typeForTail(tail);
    }
    if (f.date) out.push(normalize(f));
  }
  return out;
}
const dupKey = f => [f.date, f.aircraft || '', (f.route || '').replace(/\s+/g, ' '), r1(f.total).toFixed(1)].join('|');
function renderImport() {
  const opts = sel => IMPORT_TARGETS.map(([k, l]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
  $('#impMap').innerHTML = '<thead><tr><th>Column in your file</th><th>Example</th><th>Goes into</th></tr></thead><tbody>' +
    imp.header.map((h, i) => {
      const sample = imp.rows.map(r => r[i]).find(v => v && v.trim()) || '';
      return `<tr class="${imp.map[i] ? '' : 'unmapped'}"><td>${esc(h || `(column ${i + 1})`)}</td><td class="sample">${esc(sample)}</td><td><select data-col="${i}">${opts(imp.map[i])}</select></td></tr>`;
    }).join('') + '</tbody>';
  renderImportPreview();
}
// Pair each file row with an existing flight (same date, aircraft, route and flight time).
// Identical flights on the same day are matched one-for-one, so genuine repeats still count.
function planImport() {
  const list = importFlights(), byKey = new Map();
  for (const f of live()) { const k = dupKey(f); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(f); }
  const plan = { list, fresh: [], matched: [] };
  for (const f of list) {
    const pool = byKey.get(dupKey(f));
    if (pool && pool.length) plan.matched.push([pool.shift(), f]); else plan.fresh.push(f);
  }
  return plan;
}
// Existing flight + values from the file. Returns null when nothing would change.
function mergeInto(existing, fromFile) {
  const { _dirty, updated, ...base } = existing;
  const merged = normalize({ ...base, ...fromFile, id: existing.id, created: fromFile.created ?? existing.created });
  const canon = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
  return canon(base) === canon(merged) ? null : merged;
}
// Stable 'created' stamps that keep the file's same-day sector order (the file lists newest first).
function fileOrderCreated(list) {
  const seen = {}, m = new Map();
  for (const f of list) { const i = (seen[f.date] = (seen[f.date] || 0) + 1) - 1; m.set(f, Date.parse(f.date + 'T12:00:00Z') + 1000 - i); }
  return m;
}
// "Match this file": flights from an earlier import that are no longer in the file (deleted or edited in ZuluLog).
// Flights you entered in this app are never touched.
function staleImports(plan) {
  const used = new Set(plan.matched.map(([e]) => e.id));
  return live().filter(f => f.imported && !used.has(f.id));
}
function renderImportPreview() {
  const plan = planImport(), list = plan.list, mode = $('#impDupMode').value;
  const updating = mode === 'update' || mode === 'sync';
  const oc = fileOrderCreated(plan.list);
  const changed = updating ? plan.matched.filter(([e, f]) => mergeInto(e, mode === 'sync' ? { ...f, created: oc.get(f) } : f)).length : 0;
  const removed = mode === 'sync' ? staleImports(plan) : [];
  const skip = mode === 'again' ? 0 : plan.matched.length;
  const noDate = imp.rows.length - list.length;
  const cols = [['date', 'Date'], ['time', 'Time'], ['aircraft', 'Aircraft'], ['type', 'Type'], ['route', 'Route'], ['ifr', 'IFR'], ['role', 'Role'],
    ['fltDay', 'Flt day'], ['fltNight', 'Flt night'], ['total', 'Flt total'], ['actual', 'Act inst'], ['sic', 'SIC'], ['pic', 'PIC']];
  const val = (f, k) => HOUR_TARGETS.has(k) ? fmtH(f[k]) : k === 'ifr' ? (f.ifr ? 'IFR' : f.vfr ? 'VFR' : '') : (f[k] || '');
  $('#impPreview').innerHTML = `<thead><tr>${cols.map(c => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>` +
    (list.length ? list.slice(0, 8).map(f => `<tr>${cols.map(([k]) => `<td>${esc(val(f, k))}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="muted">No rows have a date yet — choose which column is the Date.</td></tr>`) + '</tbody>';
  const n = list.length - skip;
  const pl = x => x === 1 ? '' : 's';
  $('#impSummary').textContent = `${n} new flight${pl(n)}` +
    (plan.matched.length ? `, ${plan.matched.length} already in logbook (${updating ? `${changed} will be updated` : mode === 'again' ? 'importing again' : 'skipped'})` : '') +
    (removed.length ? `, ${removed.length} earlier-imported flight${pl(removed.length)} no longer in the file will be removed (${removed.slice(0, 3).map(f => `${f.date} ${f.aircraft || ''} ${f.route || ''} ${r1(f.total).toFixed(1)}`).join('; ')}${removed.length > 3 ? '; …' : ''})` : '') +
    (noDate ? `, ${noDate} row${pl(noDate)} without a readable date skipped` : '') +
    ` · file total ${r1(list.reduce((a, f) => a + (f.total || 0), 0)).toFixed(1)} h`;
  const work = n + changed + removed.length;
  $('#impGo').disabled = !work;
  $('#impGo').textContent = !work ? 'Nothing to import'
    : [n && `Import ${n}`, changed && `update ${changed}`, removed.length && `remove ${removed.length}`].filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase());
}
function runImport() {
  const plan = planImport(), mode = $('#impDupMode').value, now = Date.now();
  const updating = mode === 'update' || mode === 'sync';
  const removed = mode === 'sync' ? staleImports(plan) : [];
  // keep the file's order (newest first) so same-day sectors list in the right order
  const oc = fileOrderCreated(plan.list);
  const add = mode === 'again' ? plan.list : plan.fresh;
  add.forEach(f => { const id = uid(); flights[id] = { ...f, id, created: oc.get(f), updated: now, _dirty: true, imported: imp.name }; });
  let upd = 0;
  if (updating) for (const [e, f] of plan.matched) {
    const m = mergeInto(e, mode === 'sync' ? { ...f, created: oc.get(f) } : f);
    if (m) { flights[e.id] = { ...m, updated: now, _dirty: true }; upd++; }
  }
  for (const f of removed) flights[f.id] = { id: f.id, created: f.created, deleted: true, updated: now, _dirty: true };
  saveLocal(); imp = null; refreshAll(); show('log'); scheduleSync();
  const msg = [add.length && `Imported ${add.length} flight${add.length === 1 ? '' : 's'}`, upd && `updated ${upd}`, removed.length && `removed ${removed.length} stale`].filter(Boolean).join(', ');
  toast(`${msg || 'Nothing changed'}${signedIn() && (add.length || upd || removed.length) ? ' — uploading to Home Assistant' : ''}.`, 4000);
}

// ---------- CASA (Excel Pilot Logbook, Australia) workbook ----------
// The workbook lives on the Home Assistant server and is rebuilt there whenever flights change
// (see casa.py). The app only shows its status and downloads it.
let casaInfo = null, casaChecked = 0;
async function refreshCasa(force) {
  if (!signedIn() || (!force && Date.now() - casaChecked < 15000)) return renderCasa();
  casaChecked = Date.now();
  try { casaInfo = await api('GET', 'casa'); } catch (e) { casaInfo = { error: e.offline ? 'offline' : e.message }; }
  renderCasa();
}
function renderCasa() {
  const el = $('#casaState'); if (!el) return;
  const nice = d => new Date(d + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const i = casaInfo, s = i && i.summary;
  let text = 'Sign in to see your CASA logbook.';
  if (signedIn() && !i) text = 'Checking…';
  else if (i && i.error === 'offline') text = 'Not connected – the CASA logbook is on your Home Assistant server.';
  else if (i && i.error && !s) text = 'The CASA logbook could not be built: ' + i.error;
  else if (i && !i.has_template) text = 'No CASA workbook on the server yet.';
  else if (s) text = `Up to date: your workbook's flights to ${nice(s.cutoff)}, plus ${s.new_flights} flight${s.new_flights === 1 ? '' : 's'} added since (${s.new_hours.toFixed(1)} h).` +
    (s.retyped && s.retyped.length ? ` ${s.retyped.length} aircraft type${s.retyped.length === 1 ? '' : 's'} corrected.` : '');
  el.textContent = text;
  $('#casaDownload').disabled = !(i && i.has_template);
}
function wireCasa() {
  $('#casaDownload').onclick = async () => {
    try {
      const tok = await getToken();
      const r = await fetchT('/api/pilot_logbook/casa.xlsx', { headers: { Authorization: 'Bearer ' + tok } }, 60000);
      if (!r.ok) throw new Error('server ' + r.status);
      const blob = await r.blob(), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `CASA-Logbook-${todayLocal()}.xlsx`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    } catch (e) { toast(e.offline ? 'Connect to the internet to download the CASA logbook.' : 'Could not download the CASA logbook.', 4000); }
  };
  $('#casaUpload').onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    if (!confirm(`Use "${file.name}" as your CASA workbook? The server keeps it and adds every later flight to it automatically.`)) return;
    try { await uploadCasaTemplate(await file.arrayBuffer()); toast('CASA workbook saved on the server.'); }
    catch (err) { toast('Could not use that workbook: ' + err.message, 5000); }
  };
}
async function uploadCasaTemplate(bytes) {
  const tok = await getToken();
  const r = await fetchT('/api/pilot_logbook/casa/template', { method: 'PUT', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/octet-stream' }, body: bytes }, 120000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'server ' + r.status);
  casaInfo = { has_template: true, summary: j.summary, error: j.error }; casaChecked = Date.now(); renderCasa();
  return j;
}

// Apply the fleet rules (and your per-tail choices) to every past flight, after showing what will change.
function fixPastTypes() {
  const ov = tailOverrides(), changes = [], fixes = new Map();
  let blank = 0, wrong = 0;
  for (const f of live()) {
    const tail = String(f.aircraft || '').toUpperCase().trim();
    const want = ov[tail] || tailRuleType(tail);
    if (!want || want === f.type) continue;
    if (f.type) { wrong++; const k = `${tail}: ${f.type} → ${want}`; fixes.set(k, (fixes.get(k) || 0) + 1); } else blank++;
    changes.push([f, { type: want }]);
  }
  const examples = [...fixes].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n} flight${n === 1 ? '' : 's'})`);
  if (!changes.length) { toast('All aircraft types already match the fleet rules.'); return; }
  const msg = `Update the aircraft type on ${changes.length} flight${changes.length === 1 ? '' : 's'}?\n\n` +
    `• ${blank} with no type will get one\n• ${wrong} will be corrected` + (examples.length ? `\n\nFor example:\n${examples.join('\n')}` : '');
  if (!confirm(msg)) return;
  bulkUpdate(changes);
  toast(`Updated the aircraft type on ${changes.length} flights.`, 4000);
}

// ---------- shell ----------
function show(view) {
  if (view !== 'log' && !confirmDiscard()) return;
  if (view !== 'log' && formDirty) { formDirty = false; }
  if (view !== 'log' && editingId) closeEditor();
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + view; });
  $$('.tabbar button[data-view], .menu button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $('#menu').hidden = true;
  $('#viewTitle').textContent = { log: 'Pilot Logbook', totals: 'Totals', settings: 'Settings', import: 'Import flights' }[view] || 'Pilot Logbook';
  $('#searchBtn').hidden = view !== 'log';
  if (view === 'totals') renderTotals();
  if (view === 'settings') renderSettings();
}
function refreshAll() {
  renderList(); renderDatalists();
  if (!$('#view-totals').hidden) renderTotals();
  renderSettings();
}
const systemDark = () => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && systemDark());
  root.setAttribute('data-dark', dark ? '1' : '0');
  $('#themeBtn').title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}
function setTheme(t) { store.set('pl.theme', t); $('#themeSel').value = t; applyTheme(t); }
function tickZulu() { const d = new Date(); $('#zulu').textContent = d.toISOString().slice(11, 16).replace(':', '') + 'Z'; }

async function init() {
  // Older records saved by the first version of this app get their Day/Night split filled in.
  let migrated = false;
  for (const f of Object.values(flights)) if (!f.deleted && !f.kind && f.fltDay == null) { normalize(f); migrated = true; }
  if (migrated) saveLocal();

  $('#search').value = '';   // browsers sometimes autofill/restore this box, which would hide flights
  buildForm(); wireForm();
  $$('.tabbar button[data-view], .menu button').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#menuBtn').onclick = e => {
    e.stopPropagation();
    if (document.body.classList.contains('editing')) { if (confirmDiscard()) closeEditor(); return; }   // back arrow
    $('#menu').hidden = !$('#menu').hidden;
  };
  $('#fixTypes').onclick = fixPastTypes;
  wireCasa();
  document.addEventListener('click', e => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
  $('#themeBtn').onclick = () => setTheme(document.documentElement.getAttribute('data-dark') === '1' ? 'light' : 'dark');
  $('#searchBtn').onclick = () => {
    const box = $('#listtools'); box.hidden = !box.hidden;
    if (box.hidden) { $('#search').value = ''; renderList(); } else $('#search').focus();
  };
  $('#search').oninput = () => { listLimit = 300; renderList(); };
  $('#newBtn').onclick = () => openEditor(blankFlight(), true);
  $('#list').onclick = e => {
    if (e.target.id === 'moreBtn') { listLimit += 500; renderList(); return; }
    const it = e.target.closest('.item'); if (it && flights[it.dataset.id]) openEditor(flights[it.dataset.id]);
  };
  $('#syncBtn').onclick = () => signedIn() ? sync(true) : show('settings');
  $('#signInBtn').onclick = startLogin;
  $('#signOutBtn').onclick = () => { if (confirm('Sign out of Home Assistant on this iPad? Your flights stay on the device.')) signOut(); };
  $('#syncNowBtn').onclick = () => sync(true);
  $('#tokenSave').onclick = () => {
    const t = $('#tokenInput').value.trim(); if (!t) return;
    auth = { longLived: t }; store.set('pl.auth', auth); $('#tokenInput').value = ''; renderSettings(); sync();
  };
  $('#exportCsv').onclick = exportCsv;
  $('#exportJson').onclick = exportJson;
  $('#importJson').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importJson(f); };
  $('#importCsv').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) startCsvImport(f); };
  $('#impMap').onchange = e => {
    const c = e.target.dataset.col; if (c == null) return;
    imp.map[+c] = e.target.value; e.target.closest('tr').classList.toggle('unmapped', !e.target.value);
    if (e.target.value === 'date') imp.autoFmt = detectDateFmt(imp.rows.slice(0, 500).map(r => r[+c] || ''));
    renderImportPreview();
  };
  $('#impDateFmt').onchange = renderImportPreview;
  $('#impDupMode').onchange = renderImportPreview;
  $('#impGo').onclick = runImport;
  $('#impBack').onclick = $('#impCancel').onclick = () => { imp = null; show('settings'); };
  const theme = store.get('pl.theme', 'auto'); $('#themeSel').value = theme; applyTheme(theme);
  $('#themeSel').onchange = e => setTheme(e.target.value);
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('pl.theme', 'auto'))); } catch { /* old browsers */ }
  window.addEventListener('beforeunload', e => { if (formDirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('online', () => scheduleSync());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(); });
  // check every minute while flights are waiting to sync (so it catches the switch to 4G after landing), else every 2
  let lastAuto = Date.now();
  setInterval(() => {
    if (document.hidden || syncing) return;
    if (Date.now() - lastAuto >= (pendingCount() ? 60e3 : 120e3)) { lastAuto = Date.now(); sync(); }
  }, 15e3);
  tickZulu(); setInterval(tickZulu, 5e3);

  refreshAll();
  await handleLoginRedirect();
  renderSettings();
  sync();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js?v=' + APP_VERSION).catch(() => {});   // versioned so Cloudflare can't serve an old one
  }
}
init();
