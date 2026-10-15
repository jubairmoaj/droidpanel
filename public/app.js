import { api } from './api.js';
import { Mirror } from './mirror.js';
import { ic, hydrateIcons, setBtn } from './icons.js';

hydrateIcons();

// ── Helpers ─────────────────────────────────────────────────────────────────
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(`dp.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`dp.${k}`, v); } catch { /* private mode */ } },
};

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = `toast${err ? ' err' : ''}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
const fail = (e) => toast(e.message ?? String(e), true);

/** Run an async action with the button disabled; toasts errors. */
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { fail(e); } finally { if (btn) btn.disabled = false; }
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

const state = { serial: store.get('serial', ''), devices: [], scrcpy: { available: false }, tab: store.get('tab', 'overview') };
const needDevice = () => {
  if (!state.serial) throw new Error('Select a device first');
  return state.serial;
};

// ── Theme ───────────────────────────────────────────────────────────────────
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
applyTheme(store.get('theme', ''));
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  store.set('theme', next);
};

// ── Tabs ────────────────────────────────────────────────────────────────────
function showTab(name, refresh = true) {
  state.tab = name;
  store.set('tab', name);
  $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('[data-panel]').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (refresh) refreshTab();
}
$$('[data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function refreshTab() {
  if (state.tab === 'overview') loadOverview();
  if (state.tab === 'apps') loadApps();
  if (state.tab === 'build') loadProjects();
  if (state.tab === 'tools') loadPanelLog();
}

// ── Devices ─────────────────────────────────────────────────────────────────
const deviceLabel = (d) => {
  const name = d.model || d.serial;
  const via = d.transport === 'wifi' ? 'Wi-Fi' : 'USB';
  const st = d.state === 'device' ? '' : ` — ${d.state}`;
  return `${name} · ${via}${st}`;
};

async function loadDevices() {
  let data;
  try { data = await api('/api/devices'); } catch { return; }
  state.scrcpy = data.scrcpy;
  const list = data.devices;
  const sig = JSON.stringify(list);
  if (sig === state.devSig && state.devicesLoaded) return;
  state.devSig = sig;
  state.devices = list;
  state.devicesLoaded = true;
  const sel = $('#deviceSelect');
  if (!data.adb) {
    sel.innerHTML = '<option value="">adb not found — install Android platform-tools</option>';
    return;
  }
  const ready = list.filter((d) => d.state === 'device');
  sel.innerHTML = list.length
    ? list.map((d) => `<option value="${esc(d.serial)}"${d.state !== 'device' ? ' disabled' : ''}>${esc(deviceLabel(d))}</option>`).join('')
    : '<option value="">No device — connect one</option>';
  if (!ready.some((d) => d.serial === state.serial)) {
    selectDevice(ready[0]?.serial ?? '');
  } else {
    sel.value = state.serial;
  }
  const unauthorized = list.find((d) => d.state === 'unauthorized');
  if (unauthorized) toast(`${unauthorized.serial}: accept the "Allow USB debugging" prompt on the phone`);
  renderWifiDevices();
  updateDot();
}

function updateDot() {
  const d = state.devices.find((x) => x.serial === state.serial);
  $('#devDot').className = `dot${d?.state === 'device' ? ' on' : d ? ' warn' : ''}`;
}

function selectDevice(serial) {
  if (serial === state.serial && state.devicesLoaded && state.selectedOnce) return;
  state.selectedOnce = true;
  const changed = serial !== state.serial;
  state.serial = serial;
  store.set('serial', serial);
  $('#deviceSelect').value = serial;
  if (changed) {
    mirror.stop();
    stopLogcat();
  }
  mirror.serial = serial || null;
  updateDot();
  refreshTab();
  syncRecording();
}
$('#deviceSelect').onchange = (e) => selectDevice(e.target.value);

// ── Mirror ──────────────────────────────────────────────────────────────────
const mirror = new Mirror({
  canvas: $('#screen'),
  stage: $('#stage'),
  toast,
  onStats: (s) => { $('#mirrorStats').textContent = s; },
  onState: (s, msg) => {
    const btn = $('#mirrorBtn');
    const on = s === 'connecting' || s === 'live';
    setBtn(btn, on ? 'stop' : 'play', on ? 'Stop' : 'Mirror', on ? 'c-red' : 'primary');
    if (s === 'connecting') $('#mirrorStats').textContent = 'Connecting…';
    if (s === 'off') $('#mirrorStats').textContent = '—';
    if (s === 'error') toast(`Mirror: ${msg}`, true);
    if (s === 'ended') toast('Mirror ended (device disconnected?)');
    if (s === 'live') $('#screen').focus();
  },
});
$('#mirrorQuality').value = store.get('quality', '1024,30,4');
$('#mirrorQuality').onchange = (e) => {
  store.set('quality', e.target.value);
  if (mirror.active) mirror.start(state.serial, e.target.value, state.scrcpy.available);
};
$('#mirrorBtn').onclick = () => {
  if (mirror.active) return mirror.stop();
  try {
    mirror.start(needDevice(), $('#mirrorQuality').value, state.scrcpy.available);
  } catch (e) { fail(e); }
};
$$('[data-key]').forEach((b) => (b.onclick = () => {
  if (!state.serial) return toast('Select a device first', true);
  if (b.dataset.key === '4') mirror.backOrScreenOn(); else mirror.key(Number(b.dataset.key));
}));
$('#notifBtn').onclick = () => mirror.notifications();
$('#rotateBtn').onclick = () => mirror.rotate();

// ── Screenshot ──────────────────────────────────────────────────────────────
async function copyScreenshot() {
  const serial = needDevice();
  const btn = $('#shotBtn');
  btn.disabled = true;
  const blob = fetch(`/api/screenshot?serial=${encodeURIComponent(serial)}`).then(async (r) => {
    if (!r.ok) throw new Error((await r.json()).error);
    return r.blob();
  });
  try {
    // Passing a Promise keeps the user-gesture alive while the PNG downloads.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Screenshot copied to clipboard');
  } catch (e) {
    try {
      await blob; // surface device errors first
      const r = await api('/api/screenshot/copy', { body: { serial } });
      toast(`Screenshot copied (via ${r.via})`);
    } catch (e2) { fail(e2); }
  } finally {
    btn.disabled = false;
  }
}
$('#shotBtn').onclick = () => copyScreenshot().catch(fail);
$('#shotSaveBtn').onclick = () => {
  try {
    download(`/api/screenshot?serial=${encodeURIComponent(needDevice())}`, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  } catch (e) { fail(e); }
};
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    copyScreenshot().catch(fail);
  }
});

// ── Screen recording ────────────────────────────────────────────────────────
let recTimer = null;
function setRecUi(startedAt) {
  const btn = $('#recBtn');
  clearInterval(recTimer);
  if (!startedAt) {
    setBtn(btn, 'record', 'Record', 'c-red');
    btn.classList.remove('recording');
    return;
  }
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    setBtn(btn, 'stop', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, 'solid-red');
    btn.classList.add('recording');
  };
  tick();
  recTimer = setInterval(tick, 1000);
}
async function syncRecording() {
  if (!state.serial) return setRecUi(null);
  try {
    const r = await api(`/api/record?serial=${encodeURIComponent(state.serial)}`);
    setRecUi(r.recording ? r.startedAt : null);
  } catch { setRecUi(null); }
}
$('#recBtn').onclick = (e) => busy(e.currentTarget, async () => {
  const serial = needDevice();
  if ($('#recBtn').classList.contains('recording')) {
    toast('Saving recording…');
    const r = await api('/api/record/stop', { body: { serial } });
    setRecUi(null);
    download(r.file);
  } else {
    const r = await api('/api/record/start', { body: { serial } });
    setRecUi(r.startedAt);
    toast('Recording… (Android limits a recording to 3 minutes)');
  }
});

// ── Overview ────────────────────────────────────────────────────────────────
async function loadOverview() {
  const grid = $('#infoGrid');
  if (!state.serial) {
    grid.innerHTML = '<p class="muted">No device selected. Use <b>＋ Connect device</b>.</p>';
    $('#toggles').innerHTML = '';
    $('#reverseList').innerHTML = '';
    return;
  }
  const serial = state.serial;
  api(`/api/info?serial=${encodeURIComponent(serial)}`).then((i) => {
    if (serial !== state.serial) return;
    const up = `${Math.floor(i.uptimeSec / 3600)}h ${Math.floor((i.uptimeSec % 3600) / 60)}m`;
    const stats = [
      ['Device', `${i.manufacturer} ${i.model}`],
      ['Android', `${i.android} (API ${i.sdk})`],
      ['Battery', Number.isFinite(i.battery.level) ? `${i.battery.level}%${i.battery.charging ? ' ⚡' : ''}${i.battery.temp ? ` · ${i.battery.temp}°C` : ''}` : '—'],
      ['Screen', `${i.screen} @ ${i.density}dpi`],
      ['Storage', i.storage ? `${i.storage.free} free / ${i.storage.size}` : '—'],
      ['Wi-Fi IP', i.ip ?? '—'],
      ['CPU ABI', i.abi],
      ['Uptime', up],
    ];
    grid.innerHTML = stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('');
  }).catch(fail);
  api(`/api/toggles?serial=${encodeURIComponent(serial)}`).then((list) => {
    if (serial !== state.serial) return;
    $('#toggles').innerHTML = list.map((t) => `
      <label class="switch"><span>${esc(t.label)}</span><input type="checkbox" data-toggle="${t.name}"${t.on ? ' checked' : ''}></label>`).join('');
    $$('[data-toggle]').forEach((cb) => (cb.onchange = async () => {
      cb.disabled = true;
      try {
        await api('/api/toggles', { body: { serial, name: cb.dataset.toggle, on: cb.checked } });
      } catch (e) {
        cb.checked = !cb.checked;
        fail(e);
      } finally { cb.disabled = false; }
    }));
  }).catch(fail);
  loadReverse();
}

async function loadReverse() {
  if (!state.serial) return;
  const list = await api(`/api/reverse?serial=${encodeURIComponent(state.serial)}`).catch(() => []);
  $('#reverseList').innerHTML = list.length
    ? list.map((r) => `<span class="chip">${esc(r.remote)} → ${esc(r.local)} <button data-rev="${esc(r.remote)}" title="Remove">✕</button></span>`).join('')
    : '<span class="muted small">No reverse ports. Tip: reverse 4000 so the app can call http://localhost:4000 on your PC.</span>';
  $$('[data-rev]').forEach((b) => (b.onclick = () => busy(b, async () => {
    await api('/api/reverse', { body: { serial: state.serial, remove: b.dataset.rev } });
    loadReverse();
  })));
}
$('#reverseForm').onsubmit = (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const r = await api('/api/reverse', { body: { serial: needDevice(), remote: $('#revRemote').value, local: $('#revLocal').value || $('#revRemote').value } });
    if (!r.ok) throw new Error(r.output);
    $('#revRemote').value = $('#revLocal').value = '';
    loadReverse();
  });
};

// ── Apps ────────────────────────────────────────────────────────────────────
let apps = [];
let selectedApp = store.get('app', '');
async function loadApps() {
  if (!state.serial) {
    $('#appList').innerHTML = '';
    return;
  }
  try {
    apps = await api(`/api/apps?serial=${encodeURIComponent(state.serial)}&all=${$('#appAll').checked ? 1 : 0}`);
    renderApps();
    $('#pkgOptions').innerHTML = apps.map((p) => `<option value="${esc(p)}">`).join('');
    if (selectedApp && apps.includes(selectedApp)) showApp(selectedApp);
  } catch (e) { fail(e); }
}
function renderApps() {
  const qs = $('#appSearch').value.trim().toLowerCase();
  const list = qs ? apps.filter((p) => p.toLowerCase().includes(qs)) : apps;
  $('#appList').innerHTML = list.map((p) => `<li data-pkg="${esc(p)}"${p === selectedApp ? ' class="sel"' : ''}>${esc(p)}</li>`).join('')
    || '<li class="muted">No packages</li>';
}
$('#appSearch').oninput = renderApps;
$('#appAll').onchange = loadApps;
$('#appRefresh').onclick = loadApps;
$('#appList').onclick = (e) => {
  const li = e.target.closest('[data-pkg]');
  if (!li) return;
  selectedApp = li.dataset.pkg;
  store.set('app', selectedApp);
  $$('#appList li').forEach((x) => x.classList.toggle('sel', x === li));
  showApp(selectedApp);
};

async function showApp(pkg) {
  const box = $('#appDetail');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await api(`/api/app?serial=${encodeURIComponent(state.serial)}&pkg=${encodeURIComponent(pkg)}`);
    box.innerHTML = `
      <h4>${esc(pkg)}</h4>
      <dl class="kv">
        <dt>Version</dt><dd>${esc(d.versionName ?? '—')} (${esc(d.versionCode ?? '—')})</dd>
        <dt>Target SDK</dt><dd>${esc(d.targetSdk ?? '—')}</dd>
        <dt>Status</dt><dd>${d.pids.length ? `running (pid ${esc(d.pids.join(', '))})` : 'not running'}</dd>
        <dt>Installed</dt><dd>${esc(d.firstInstall ?? '—')}</dd>
        <dt>Updated</dt><dd>${esc(d.lastUpdate ?? '—')}</dd>
      </dl>
      <div class="btn-grid">
        <button class="btn primary" data-act="launch">${ic('play')}<span>Launch</span></button>
        <button class="btn c-blue" data-act="restart">${ic('restart')}<span>Restart</span></button>
        <button class="btn c-amber" data-act="stop">${ic('stop')}<span>Force stop</span></button>
        <button class="btn c-teal" data-act="logcat">${ic('logs')}<span>Logcat</span></button>
        <button class="btn c-gray" data-act="info">${ic('info')}<span>App info</span></button>
        <button class="btn c-purple" data-act="apk">${ic('download')}<span>APK</span></button>
        <button class="btn c-red" data-act="clear">${ic('eraser')}<span>Clear data</span></button>
        <button class="btn c-red" data-act="uninstall">${ic('trash')}<span>Uninstall</span></button>
      </div>`;
    $$('[data-act]', box).forEach((b) => (b.onclick = () => appAction(pkg, b.dataset.act, b)));
  } catch (e) {
    box.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

async function appAction(pkg, action, btn) {
  if (action === 'logcat') {
    $('#logPkg').value = pkg;
    showTab('logcat');
    if (!logSource) startLogcat();
    else renderLog(true);
    return;
  }
  if (action === 'apk') return download(`/api/app/apk?serial=${encodeURIComponent(state.serial)}&pkg=${encodeURIComponent(pkg)}`, `${pkg}.apk`);
  if ((action === 'clear' || action === 'uninstall') && !confirm(`${action === 'clear' ? 'Clear all data of' : 'Uninstall'} ${pkg}?`)) return;
  await busy(btn, async () => {
    const r = await api('/api/app', { body: { serial: state.serial, pkg, action } });
    if (!r.ok) throw new Error(r.output || 'Failed');
    toast(`${action}: done`);
    if (action === 'uninstall') { selectedApp = ''; loadApps(); $('#appDetail').innerHTML = '<p class="muted">Select an app.</p>'; } else setTimeout(() => showApp(pkg), 600);
  });
}

// Drag & drop helpers for APK install / file push
function dropZone(zone, input, onFile) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    [...e.dataTransfer.files].forEach(onFile);
  });
  input.onchange = () => { [...input.files].forEach(onFile); input.value = ''; };
}
dropZone($('#apkDrop'), $('#apkInput'), async (file) => {
  try {
    const serial = needDevice();
    if (!file.name.endsWith('.apk')) throw new Error('That is not an .apk file');
    toast(`Installing ${file.name}…`);
    const r = await api(`/api/install?serial=${encodeURIComponent(serial)}`, { body: file, raw: true, headers: { 'content-type': 'application/octet-stream' } });
    if (!r.ok) throw new Error(r.output);
    toast(`Installed ${file.name}`);
    loadApps();
  } catch (e) { fail(e); }
});
dropZone($('#fileDrop'), $('#fileInput'), async (file) => {
  try {
    const serial = needDevice();
    toast(`Sending ${file.name}…`);
    const r = await api(`/api/push?serial=${encodeURIComponent(serial)}&name=${encodeURIComponent(file.name)}`, { body: file, raw: true, headers: { 'content-type': 'application/octet-stream' } });
    if (!r.ok) throw new Error(r.output);
    toast(`Saved to ${r.remote}`);
  } catch (e) { fail(e); }
});

// ── Logcat ──────────────────────────────────────────────────────────────────
const LEVELS = 'VDIWEF';
const LINE_RE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*)$/;
const MAX_BUFFER = 30000;
const MAX_DOM = 4000;
let logBuffer = [];
let logSource = null;
let logPaused = false;
let pidSet = new Set();
let pidTimer = null;

const parseLine = (raw) => {
  const m = LINE_RE.exec(raw);
  return m ? { raw, pid: m[2], level: m[4] === 'A' ? 'F' : m[4] } : { raw, pid: null, level: 'V' };
};

function logFilter() {
  const min = LEVELS.indexOf($('#logLevel').value);
  const pkg = $('#logPkg').value.trim();
  const q = $('#logSearch').value.trim();
  let re = null;
  if (q) {
    try { re = new RegExp(q, 'i'); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  }
  return { re, test: (l) => LEVELS.indexOf(l.level) >= min && (!pkg || (l.pid && pidSet.has(l.pid))) && (!re || re.test(l.raw)) };
}

function lineEl(l, re) {
  const div = document.createElement('div');
  div.className = `l-${l.level}`;
  if (!re) {
    div.textContent = l.raw;
    return div;
  }
  const g = new RegExp(re.source, 'gi');
  let last = 0;
  for (const m of l.raw.matchAll(g)) {
    if (!m[0]) break;
    div.append(l.raw.slice(last, m.index));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    div.append(mark);
    last = m.index + m[0].length;
  }
  div.append(l.raw.slice(last));
  return div;
}

function renderLog(full, added = []) {
  const view = $('#logView');
  const f = logFilter();
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 30;
  if (full) {
    view.textContent = '';
    const frag = document.createDocumentFragment();
    logBuffer.filter(f.test).slice(-MAX_DOM).forEach((l) => frag.append(lineEl(l, f.re)));
    view.append(frag);
  } else {
    const frag = document.createDocumentFragment();
    added.filter(f.test).forEach((l) => frag.append(lineEl(l, f.re)));
    view.append(frag);
    while (view.childElementCount > MAX_DOM) view.firstElementChild.remove();
  }
  $('#logCount').textContent = `${view.childElementCount} shown · ${logBuffer.length} buffered`;
  if (atBottom || full) view.scrollTop = view.scrollHeight;
}

async function refreshPids() {
  const pkg = $('#logPkg').value.trim();
  if (!pkg || !state.serial) { pidSet = new Set(); return; }
  try {
    const d = await api(`/api/app?serial=${encodeURIComponent(state.serial)}&pkg=${encodeURIComponent(pkg)}`);
    const before = pidSet.size;
    d.pids.forEach((p) => pidSet.add(p)); // keep old pids so lines from before a restart stay visible
    if (pidSet.size !== before) renderLog(true);
  } catch { /* invalid package while typing */ }
}

function startLogcat() {
  try { needDevice(); } catch (e) { return fail(e); }
  stopLogcat();
  logBuffer = [];
  pidSet = new Set();
  refreshPids().then(() => renderLog(true));
  pidTimer = setInterval(refreshPids, 2000);
  logSource = new EventSource(`/api/logcat?serial=${encodeURIComponent(state.serial)}&tail=500`);
  logSource.onmessage = (e) => {
    const added = JSON.parse(e.data).map(parseLine);
    logBuffer.push(...added);
    if (logBuffer.length > MAX_BUFFER) logBuffer.splice(0, logBuffer.length - MAX_BUFFER);
    if (!logPaused) renderLog(false, added);
  };
  logSource.addEventListener('end', () => { stopLogcat(); toast('Logcat ended'); });
  logSource.onerror = () => { if (logSource?.readyState === EventSource.CLOSED) stopLogcat(); };
  setBtn($('#logToggle'), 'stop', 'Stop', 'c-red');
}

function stopLogcat() {
  logSource?.close();
  logSource = null;
  clearInterval(pidTimer);
  setBtn($('#logToggle'), 'play', 'Start', 'primary');
}

$('#logToggle').onclick = () => (logSource ? stopLogcat() : startLogcat());
$('#logPause').onclick = () => {
  logPaused = !logPaused;
  setBtn($('#logPause'), logPaused ? 'play' : 'pause', logPaused ? 'Resume' : 'Pause', logPaused ? 'c-green' : 'c-amber');
  if (!logPaused) renderLog(true);
};
$('#logClear').onclick = async () => {
  logBuffer = [];
  renderLog(true);
  if (state.serial) api('/api/logcat/clear', { body: { serial: state.serial } }).catch(fail);
};
$('#logSave').onclick = () => {
  const f = logFilter();
  const blob = new Blob([logBuffer.filter(f.test).map((l) => l.raw).join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  download(url, `logcat-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
let logDebounce;
const relog = () => { clearTimeout(logDebounce); logDebounce = setTimeout(() => renderLog(true), 200); };
$('#logLevel').onchange = relog;
$('#logSearch').oninput = relog;
$('#logPkg').onchange = () => { pidSet = new Set(); refreshPids().then(() => renderLog(true)); };

// ── Build & Run ─────────────────────────────────────────────────────────────
let projects = [];
let currentJob = store.get('job', '');
let jobFrom = 0;
let jobTimer = null;
let jobWasRunning = false;

// [task, icon, label, colour class, tooltip]
const TASK_BUTTONS = (p) => [
  p.type === 'flutter'
    ? ['run', 'play', 'flutter run', 'primary', 'Debug run on the phone with hot reload']
    : ['run', 'play', 'Run', 'primary', 'Build, install and launch'],
  ['deploy-debug', 'rocket', 'Rebuild & launch', 'c-teal', 'Stop → build debug → install → launch'],
  ['build-debug', 'hammer', 'Build debug', 'c-blue', 'Build a debug APK'],
  ['build-release', 'hammer', 'Build release', 'c-blue', 'Build a release APK'],
  ['install-debug', 'package', 'Install debug', 'c-amber', 'Install the last debug APK'],
  ['install-release', 'package', 'Install release', 'c-amber', 'Install the last release APK'],
  ['launch', 'play', 'Launch', 'c-green', 'Open the app on the phone'],
  ['stop', 'stop', 'Stop app', 'c-red', 'Force-stop the app'],
  ['clean', 'sparkles', 'Clean', 'c-gray', 'Delete build outputs'],
];

async function loadProjects() {
  try {
    const data = await api('/api/projects');
    projects = data.projects;
    renderProjects();
    loadDiscovered();
    if (!currentJob && data.jobs[0]) currentJob = data.jobs[0].id;
    if (currentJob) followJob(currentJob, true);
  } catch (e) { fail(e); }
}

function renderProjects() {
  $('#projects').innerHTML = projects.length ? projects.map((p) => `
    <div class="project" data-id="${p.id}">
      <div class="project-head">
        <b>${esc(p.name)}</b><span class="badge">${esc(p.type)}</span>
        ${p.running ? '<span class="badge running">running</span>' : ''}
        <span class="spacer"></span>
        <button class="btn icon c-gray" data-remove title="Remove from list" aria-label="Remove">${ic('x')}</button>
      </div>
      <div class="meta">${esc(p.root)}</div>
      <div class="row">
        <input data-field="packageId" value="${esc(p.packageId)}" placeholder="Application id, e.g. com.example.app" title="Application id">
      </div>
      <div class="row">
        <input data-field="buildArgs" value="${esc(p.buildArgs)}" placeholder="${p.type === 'flutter' ? 'Extra args, e.g. --dart-define=API_BASE_URL=http://192.168.0.10:4000' : 'Extra Gradle args, e.g. -PmyProp=1'}" title="Extra build/run arguments">
      </div>
      <div class="btn-grid">
        ${TASK_BUTTONS(p).map(([t, icon, label, cls, title]) => `<button class="btn ${cls}" data-task="${t}" title="${esc(title)}">${ic(icon)}<span>${esc(label)}</span></button>`).join('')}
      </div>
    </div>`).join('') : '<p class="muted">No projects yet. Add a Flutter, native Android (Gradle) or React Native project folder above.</p>';

  $$('.project').forEach((card) => {
    const id = card.dataset.id;
    $$('[data-field]', card).forEach((inp) => (inp.onchange = () => api('/api/projects/update', { body: { id, [inp.dataset.field]: inp.value } })
      .then(() => toast('Saved')).catch(fail)));
    $('[data-remove]', card).onclick = () => {
      if (!confirm('Remove this project from droidpanel? (Files are not touched.)')) return;
      api('/api/projects/remove', { body: { id } }).then(loadProjects).catch(fail);
    };
    $$('[data-task]', card).forEach((b) => (b.onclick = () => busy(b, async () => {
      const needsDevice = !b.dataset.task.startsWith('build') && b.dataset.task !== 'clean';
      const job = await api('/api/projects/run', { body: { id, task: b.dataset.task, serial: needsDevice ? needDevice() : state.serial || undefined } });
      followJob(job.id);
      loadProjectsSoon();
    })));
  });
}
async function loadDiscovered() {
  const box = $('#discovered');
  if (!box.childElementCount) box.innerHTML = '<p class="muted small">Looking for projects on this PC…</p>';
  const found = await api('/api/projects/discover').catch(() => []);
  box.innerHTML = found.length ? `<h3>Found on this PC</h3>${found.map((p) => `
    <div class="mdns-item"><span><b>${esc(p.name)}</b> <span class="badge">${esc(p.type)}</span><br><span class="muted small">${esc(p.root)}</span></span>
    <button class="btn primary" data-add="${esc(p.root)}">${ic('plus')}<span>Add</span></button></div>`).join('')}` : '';
  $$('[data-add]', box).forEach((b) => (b.onclick = () => busy(b, async () => {
    const p = await api('/api/projects', { body: { path: b.dataset.add } });
    toast(`Added ${p.name} (${p.type})`);
    loadProjects();
  })));
}

const loadProjectsSoon = () => setTimeout(() => api('/api/projects').then((d) => { projects = d.projects; renderProjects(); }), 300);

$('#projectForm').onsubmit = (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const p = await api('/api/projects', { body: { path: $('#projectPath').value.trim() } });
    $('#projectPath').value = '';
    toast(`Added ${p.name} (${p.type})`);
    loadProjects();
  });
};

function followJob(id, keep = false) {
  if (!keep || id !== currentJob) {
    jobFrom = 0;
    $('#jobLog').textContent = '';
  }
  currentJob = id;
  store.set('job', id);
  $('#jobBox').hidden = false;
  clearTimeout(jobTimer);
  pollJob();
}

async function pollJob() {
  if (!currentJob) return;
  let j;
  try {
    j = await api(`/api/jobs/log?id=${currentJob}&from=${jobFrom}`);
  } catch {
    $('#jobBox').hidden = true;
    currentJob = '';
    return;
  }
  const pre = $('#jobLog');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  if (j.lines.length) {
    pre.append(document.createTextNode(`${j.lines.join('\n')}\n`));
    if (pre.textContent.length > 400000) pre.textContent = pre.textContent.slice(-300000);
    jobFrom = j.from + j.lines.length;
  }
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  $('#jobTitle').textContent = `${j.project} · ${j.task}${j.step && j.status === 'running' ? ` · ${j.step}` : ''}`;
  const st = $('#jobStatus');
  st.textContent = j.status;
  st.className = `badge ${j.status}`;
  $('#jobStop').hidden = j.status !== 'running';
  $('#hotKeys').hidden = !(j.interactive && j.status === 'running');
  if (j.status === 'running') {
    jobWasRunning = true;
    jobTimer = setTimeout(pollJob, 600);
  } else if (jobWasRunning) {
    jobWasRunning = false;
    loadProjectsSoon();
    toast(`${j.project}: ${j.task} ${j.status === 'ok' ? 'finished' : j.status}`, j.status === 'failed');
  }
}
$('#jobStop').onclick = () => api('/api/jobs/stop', { body: { id: currentJob } }).catch(fail);
$$('[data-hot]').forEach((b) => (b.onclick = () => api('/api/jobs/input', { body: { id: currentJob, data: b.dataset.hot } })
  .then(() => toast(b.dataset.hot === 'r' ? 'Hot reload' : 'Hot restart')).catch(fail)));

// ── Tools ───────────────────────────────────────────────────────────────────
$('#linkForm').onsubmit = (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const r = await api('/api/open-url', { body: { serial: needDevice(), url: $('#linkUrl').value.trim(), pkg: $('#linkPkg').value.trim() || undefined } });
    if (!r.ok) throw new Error(r.output);
    toast('Opened');
  });
};
$('#textForm').onsubmit = (e) => {
  e.preventDefault();
  try {
    needDevice();
    mirror.text($('#textValue').value);
    $('#textValue').value = '';
  } catch (err) { fail(err); }
};

const shellHistory = JSON.parse(store.get('shellHistory', '[]'));
let histIdx = shellHistory.length;
$('#shellForm').onsubmit = (e) => {
  e.preventDefault();
  const cmd = $('#shellCmd').value.trim();
  busy(e.submitter, async () => {
    const r = await api('/api/shell', { body: { serial: needDevice(), cmd } });
    $('#shellOut').textContent = `$ ${cmd}\n${r.output || '(no output)'}${r.ok ? '' : `\n[exit ${r.code}]`}`;
    if (shellHistory.at(-1) !== cmd) shellHistory.push(cmd);
    shellHistory.splice(0, Math.max(0, shellHistory.length - 50));
    histIdx = shellHistory.length;
    store.set('shellHistory', JSON.stringify(shellHistory));
  });
};
$('#shellCmd').onkeydown = (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  histIdx = Math.max(0, Math.min(shellHistory.length, histIdx + (e.key === 'ArrowUp' ? -1 : 1)));
  $('#shellCmd').value = shellHistory[histIdx] ?? '';
};

async function loadPanelLog() {
  const lines = await api('/api/log').catch(() => []);
  $('#panelLog').textContent = lines.join('\n') || '(empty)';
}

// ── Connect dialog ──────────────────────────────────────────────────────────
const dialog = $('#connectDialog');
let qrPoll = null;
let mdnsPoll = null;
const connectOut = (text) => {
  const o = $('#connectOut');
  o.hidden = !text;
  o.textContent = text ?? '';
};

$('#connectBtn').onclick = () => {
  dialog.showModal();
  showCTab(store.get('ctab', 'usb'));
};
dialog.addEventListener('close', () => {
  clearInterval(qrPoll);
  clearInterval(mdnsPoll);
});
$$('[data-ctab]').forEach((b) => (b.onclick = () => showCTab(b.dataset.ctab)));

function showCTab(name) {
  store.set('ctab', name);
  $$('[data-ctab]').forEach((b) => b.classList.toggle('active', b.dataset.ctab === name));
  $$('[data-cpanel]').forEach((p) => p.classList.toggle('active', p.dataset.cpanel === name));
  connectOut('');
  clearInterval(qrPoll);
  clearInterval(mdnsPoll);
  if (name === 'qr') newQr();
  if (name === 'code') { loadMdns(); mdnsPoll = setInterval(loadMdns, 2500); }
  if (name === 'ip') renderWifiDevices();
}

let qrLib = null;
function loadQrLib() {
  qrLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
    s.onload = () => resolve(window.qrcode);
    s.onerror = () => { qrLib = null; reject(new Error('Could not load the QR library (offline?) — use pairing code instead')); };
    document.head.append(s);
  });
  return qrLib;
}

async function newQr() {
  clearInterval(qrPoll);
  $('#qrCode').innerHTML = '';
  $('#qrStatus').textContent = 'Preparing…';
  try {
    const [{ qr }, qrcode] = await Promise.all([api('/api/wireless/qr', { body: {} }), loadQrLib()]);
    const code = qrcode(0, 'M');
    code.addData(qr);
    code.make();
    $('#qrCode').innerHTML = code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    qrPoll = setInterval(async () => {
      const s = await api('/api/wireless/qr').catch(() => null);
      if (!s) return;
      $('#qrStatus').textContent = s.message ?? '';
      if (s.status === 'done') {
        clearInterval(qrPoll);
        toast('Device paired over Wi-Fi');
        state.devSig = '';
        loadDevices();
      }
      if (s.status === 'failed') clearInterval(qrPoll);
    }, 1000);
  } catch (e) {
    $('#qrStatus').textContent = e.message;
  }
}
$('#qrNew').onclick = newQr;

async function loadMdns() {
  const list = await api('/api/wireless/mdns').catch(() => []);
  $('#mdnsList').innerHTML = list.length ? `<h3>Found on your network</h3>${list.map((s) => `
    <div class="mdns-item"><span>${esc(s.addr)} <span class="muted">${s.type.includes('pairing') ? 'pairing' : 'debugging'}</span></span>
    <button class="btn c-blue" data-mdns="${esc(s.addr)}" data-kind="${s.type.includes('pairing') ? 'pair' : 'connect'}">${ic(s.type.includes('pairing') ? 'key' : 'wifi')}<span>${s.type.includes('pairing') ? 'Use' : 'Connect'}</span></button></div>`).join('')}` : '';
  $$('[data-mdns]').forEach((b) => (b.onclick = () => {
    if (b.dataset.kind === 'pair') {
      $('#pairHost').value = b.dataset.mdns;
      $('#pairCode').focus();
    } else wifiConnect(b.dataset.mdns, b);
  }));
}

$('#pairForm').onsubmit = (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const r = await api('/api/wireless/pair', { body: { host: $('#pairHost').value.trim(), code: $('#pairCode').value.trim() } });
    connectOut(r.output);
    if (!r.ok) throw new Error('Pairing failed');
    toast('Paired! Now connect with the IP:port from the Wireless debugging screen.');
    $('#ipHost').value = $('#pairHost').value.split(':')[0] + ':';
  });
};

async function wifiConnect(host, btn) {
  await busy(btn, async () => {
    const r = await api('/api/wireless/connect', { body: { host } });
    connectOut(r.output);
    if (!r.ok) throw new Error('Connect failed');
    toast(`Connected to ${host}`);
    state.devSig = '';
    await loadDevices();
    renderWifiDevices();
  });
}
$('#ipForm').onsubmit = (e) => {
  e.preventDefault();
  wifiConnect($('#ipHost').value.trim(), e.submitter);
};

function renderWifiDevices() {
  const list = state.devices.filter((d) => d.transport === 'wifi');
  $('#wifiDevices').innerHTML = list.length
    ? list.map((d) => `<span class="chip">${esc(d.model || d.serial)} · ${esc(d.serial)} <button data-disc="${esc(d.serial)}" title="Disconnect">✕</button></span>`).join('')
    : '<span class="muted small">None</span>';
  $$('[data-disc]').forEach((b) => (b.onclick = () => busy(b, async () => {
    await api('/api/wireless/disconnect', { body: { serial: b.dataset.disc } });
    state.devSig = '';
    await loadDevices();
  })));
}

$('#usbToWifi').onclick = (e) => busy(e.currentTarget, async () => {
  const serial = needDevice();
  const d = state.devices.find((x) => x.serial === serial);
  if (d?.transport === 'wifi') throw new Error('Selected device is already on Wi-Fi');
  connectOut('Switching the phone to Wi-Fi debugging… (up to ~10 s)');
  const r = await api('/api/wireless/usb-to-wifi', { body: { serial } });
  connectOut(r.output);
  if (!r.ok) throw new Error('Could not connect over Wi-Fi — see the details in the dialog');
  toast('Connected over Wi-Fi — you can unplug the cable');
  state.devSig = '';
  loadDevices();
});

// ── Boot ────────────────────────────────────────────────────────────────────
showTab(state.tab, false);
await loadDevices();
if (!state.selectedOnce) selectDevice(state.serial);
setInterval(loadDevices, 3000);
