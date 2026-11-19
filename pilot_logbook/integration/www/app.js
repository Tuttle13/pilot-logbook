/* Pilot Logbook – iPad web app that stores flights in Home Assistant.
 * Flights are kept on the device (works offline) and synced to
 * /api/pilot_logbook/flights on the HA server it was loaded from.
 *
 * Flight record (Day/Night split matches ZuluLog):
 *   date "YYYY-MM-DD", time "HH:MM", aircraft, type, route, from, to, ifr, vfr, role "SIC"|"PIC",
 *   fltDay, fltNight, aiDay, aiNight, sicDay, sicNight, picDay, picNight
 * plus derived totals kept for exports/totals: total, night, actual, sic, pic. */
'use strict';

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
const live = () => Object.values(flights).filter(f => !f.deleted)
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
  const r = await fetch('/auth/token', { method: 'POST', body: new URLSearchParams(params) });
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
async function api(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await getToken(attempt > 0);
    if (!tok) throw new Error('not signed in');
    const r = await fetch('/api/pilot_logbook/' + path, {
      method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && attempt === 0 && !auth?.longLived) continue;
    if (r.status === 401) { if (!panelAuth()) signOut(true); throw new Error('unauthorized'); }
    if (r.status === 404) throw new Error('Pilot Logbook integration not found on Home Assistant');
    if (!r.ok) throw new Error('server ' + r.status);
    return r.json();
  }
}

// ---------- sync ----------
let syncing = false, syncTimer = null;
function setSync(cls, text) { $('#syncDot').className = 'dot ' + cls; $('#syncText').textContent = text; }
function pendingCount() { return Object.values(flights).filter(f => f._dirty).length; }
function scheduleSync(ms = 0) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function sync() {
  if (syncing) return scheduleSync(2000);
  if (!signedIn()) { setSync(pendingCount() ? 'warn' : '', 'Not signed in'); return; }
  if (!navigator.onLine) { setSync('warn', `Offline · ${pendingCount()} to sync`); return; }
  syncing = true;
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
  } catch (e) {
    setSync(signedIn() ? 'bad' : '', signedIn() ? `Sync failed · ${pendingCount()} waiting` : 'Sign in again');
    console.warn('sync', e);
    if (/not found/.test(e.message)) toast(e.message, 5000);
    if (pushed) refreshAll();
  } finally {
    syncing = false; renderSettings();
  }
}

// ---------- entry form ----------
const form = $('#form');
let editingId = null, formDirty = false;
const fld = n => form.elements.namedItem(n);

function buildForm() {
  $('#timeRows').innerHTML = SPLITS.map(([p, label]) => `
    <div class="trow" data-row="${p}">
      <span class="fl">${label}</span>
      ${['Day', 'Night'].map(dn => `
        <span class="step">
          <input name="${p}${dn}" inputmode="decimal" placeholder="${dn}" aria-label="${label} ${dn.toLowerCase()}">
          <button type="button" data-step="${p}${dn}" data-d="-0.1" aria-label="minus 0.1">−</button>
          <button type="button" data-step="${p}${dn}" data-d="0.1" aria-label="plus 0.1">+</button>
        </span>`).join('')}
      <span class="rtot" id="tot-${p}"></span>
    </div>`).join('');
}
function blankFlight() {
  const last = live()[0];
  return {
    id: uid(), created: Date.now(), date: todayLocal(), time: nowHHMM(), role: 'SIC',
    ifr: last ? !!last.ifr : true, vfr: last ? !!last.vfr : false,
  };
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
}
function fillForm(f) {
  for (const k of ['date', 'time', 'aircraft', 'type', 'route']) fld(k).value = f[k] ?? '';
  fld('role').value = f.role === 'PIC' ? 'PIC' : 'SIC';
  fld('ifr').checked = !!f.ifr; fld('vfr').checked = !!f.vfr;
  for (const k of SPLIT_KEYS) fld(k).value = f[k] ? fmtH(f[k]) : '';
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
  f.role = fld('role').value; f.ifr = fld('ifr').checked; f.vfr = fld('vfr').checked;
  for (const k of SPLIT_KEYS) {
    const v = parseHours(fld(k).value), bad = isNaN(v);
    fld(k).classList.toggle('bad', bad); if (bad) ok = false;
    f[k] = bad ? 0 : v;
  }
  for (const [p, , tot] of SPLITS) delete f[tot];   // recomputed from splits
  fld('date').classList.toggle('bad', !f.date); if (!f.date) ok = false;
  f.id = editingId; f.created = f.created || Date.now();
  if (!ok) return null;
  normalize(f);
  // Single/multi-engine time follows the aircraft type's earlier flights (e.g. B738 -> ME).
  const prev = f.type && live().find(x => x.id !== f.id && x.type === f.type && (x.me || x.se));
  if (prev) { f.me = prev.me ? f.total : 0; f.se = prev.me ? 0 : f.total; }
  return f;
}
function openEditor(f, isNew) {
  if (!confirmDiscard()) return false;
  editingId = f.id;
  fillForm(f);
  $('#formTitle').textContent = isNew ? 'Enter flight' : 'Edit flight';
  $('#delBtn').hidden = !!isNew;
  form.hidden = false;
  $('.split').classList.add('editing');
  $('#editpane').scrollTop = 0;
  return true;
}
function closeEditor() {
  editingId = null; form.hidden = true; formDirty = false;
  $('.split').classList.remove('editing');
}
function confirmDiscard() { return !formDirty || confirm('Discard your unsaved changes to this flight?'); }

function save(next) {
  const f = readForm();
  if (!f) { toast('Please fix the highlighted fields.'); return; }
  const wasNew = !flights[f.id];
  putFlight(f); formDirty = false;
  refreshAll();
  toast(wasNew ? 'Flight saved' : 'Flight updated');
  if (next === 'leg') {
    const n = blankFlight();
    Object.assign(n, { date: f.date, aircraft: f.aircraft, type: f.type, role: f.role, ifr: f.ifr, vfr: f.vfr, route: f.to ? f.to + ' ' : '' });
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
    if (t.name === 'aircraft' && t.value) {          // fill type from the last flight in that aircraft
      const ac = t.value.trim().toUpperCase();
      const prev = live().find(x => x.aircraft === ac && x.type);
      if (prev) fld('type').value = prev.type;
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
  form.addEventListener('submit', e => { e.preventDefault(); save(); });
  $('#saveLeg').onclick = () => save('leg');
  $('#backBtn').onclick = () => { if (confirmDiscard()) closeEditor(); };
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
    $('#list').innerHTML = `<div class="listempty">${all.length ? 'No flights match your search.' : 'No flights yet.<br>Import your ZuluLog logbook from Settings, or tap <b>+ New flight</b>.'}</div>`;
    return;
  }
  const html = rows.slice(0, listLimit).map(f => {
    const d = f.date ? new Date(f.date + 'T12:00') : null;
    const ai = r1(f.actual);
    return `<div class="item" data-id="${esc(f.id)}">
      <div class="s">${f._dirty ? '<span class="pend" title="Not synced yet">●</span>' : ''}</div>
      <div class="d"><b>${d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '–'}</b><span>${d ? d.getFullYear() + ' ' + d.toLocaleDateString('en-US', { weekday: 'short' }) : ''}</span></div>
      <div class="t">${r1(f.total).toFixed(1)}</div>
      <div class="ac"><b>${esc(f.type || '--')}</b><span>${esc(f.aircraft || '--')}</span></div>
      <div class="rt"><b>${esc(f.route || '--')}</b></div>
      <div class="rl"><b>${esc(f.role || '')}</b></div>
      <div class="ai">${ai ? 'AI:' + ai.toFixed(1) : ''}</div>
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
function renderImportPreview() {
  const list = importFlights();
  const existing = new Set(live().map(dupKey));
  const skip = $('#impSkipDup').checked ? list.filter(f => existing.has(dupKey(f))).length : 0;
  const noDate = imp.rows.length - list.length;
  const cols = [['date', 'Date'], ['time', 'Time'], ['aircraft', 'Aircraft'], ['type', 'Type'], ['route', 'Route'], ['ifr', 'IFR'], ['role', 'Role'],
    ['fltDay', 'Flt day'], ['fltNight', 'Flt night'], ['total', 'Flt total'], ['actual', 'Act inst'], ['sic', 'SIC'], ['pic', 'PIC']];
  const val = (f, k) => HOUR_TARGETS.has(k) ? fmtH(f[k]) : k === 'ifr' ? (f.ifr ? 'IFR' : f.vfr ? 'VFR' : '') : (f[k] || '');
  $('#impPreview').innerHTML = `<thead><tr>${cols.map(c => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>` +
    (list.length ? list.slice(0, 8).map(f => `<tr>${cols.map(([k]) => `<td>${esc(val(f, k))}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="muted">No rows have a date yet — choose which column is the Date.</td></tr>`) + '</tbody>';
  const n = list.length - skip;
  $('#impSummary').textContent = `${n} flight${n === 1 ? '' : 's'} to import` +
    (skip ? `, ${skip} already in logbook` : '') + (noDate ? `, ${noDate} row${noDate === 1 ? '' : 's'} without a readable date skipped` : '') +
    ` · ${r1(list.reduce((a, f) => a + (f.total || 0), 0)).toFixed(1)} h total`;
  $('#impGo').disabled = !n;
  $('#impGo').textContent = n ? `Import ${n} flight${n === 1 ? '' : 's'}` : 'Import';
}
function runImport() {
  const existing = new Set(live().map(dupKey));
  const list = importFlights().filter(f => !$('#impSkipDup').checked || !existing.has(dupKey(f)));
  const now = Date.now();
  list.forEach((f, i) => { const id = uid(); flights[id] = { ...f, id, created: now - i, updated: now, _dirty: true, imported: imp.name }; });
  saveLocal(); imp = null; refreshAll(); show('log'); scheduleSync();
  toast(`Imported ${list.length} flight${list.length === 1 ? '' : 's'}${signedIn() ? ' — uploading to Home Assistant' : ''}.`, 4000);
}

// ---------- shell ----------
function show(view) {
  if (view !== 'log' && !confirmDiscard()) return;
  if (view !== 'log' && formDirty) { formDirty = false; }
  if (view !== 'log' && editingId) closeEditor();
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + view; });
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'totals') renderTotals();
  if (view === 'settings') renderSettings();
}
function refreshAll() {
  renderList(); renderDatalists();
  if (!$('#view-totals').hidden) renderTotals();
  renderSettings();
}
function applyTheme(t) { if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
function tickZulu() { const d = new Date(); $('#zulu').textContent = d.toISOString().slice(11, 16).replace(':', '') + 'Z'; }

async function init() {
  // Older records saved by the first version of this app get their Day/Night split filled in.
  let migrated = false;
  for (const f of Object.values(flights)) if (!f.deleted && f.fltDay == null) { normalize(f); migrated = true; }
  if (migrated) saveLocal();

  $('#search').value = '';   // browsers sometimes autofill/restore this box, which would hide flights
  buildForm(); wireForm();
  $$('.tabbar button').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#search').oninput = () => { listLimit = 300; renderList(); };
  $('#newBtn').onclick = () => openEditor(blankFlight(), true);
  $('#list').onclick = e => {
    if (e.target.id === 'moreBtn') { listLimit += 500; renderList(); return; }
    const it = e.target.closest('.item'); if (it && flights[it.dataset.id]) openEditor(flights[it.dataset.id]);
  };
  $('#syncBtn').onclick = () => signedIn() ? sync() : show('settings');
  $('#signInBtn').onclick = startLogin;
  $('#signOutBtn').onclick = () => { if (confirm('Sign out of Home Assistant on this iPad? Your flights stay on the device.')) signOut(); };
  $('#syncNowBtn').onclick = () => sync();
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
  $('#impSkipDup').onchange = renderImportPreview;
  $('#impGo').onclick = runImport;
  $('#impBack').onclick = $('#impCancel').onclick = () => { imp = null; show('settings'); };
  const theme = store.get('pl.theme', 'auto'); $('#themeSel').value = theme; applyTheme(theme);
  $('#themeSel').onchange = e => { store.set('pl.theme', e.target.value); applyTheme(e.target.value); };
  window.addEventListener('beforeunload', e => { if (formDirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('online', () => scheduleSync());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(); });
  setInterval(() => { if (!document.hidden) sync(); }, 120e3);
  tickZulu(); setInterval(tickZulu, 5e3);

  refreshAll();
  await handleLoginRedirect();
  renderSettings();
  sync();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
