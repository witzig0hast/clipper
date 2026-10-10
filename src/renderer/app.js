'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let settings = null;
let state = null;
let clips = [];
let clipWish = 30;      // Wunschlänge des Nutzers
let clipSeconds = 30;   // tatsächlich (durch Pufferinhalt begrenzt)

// ---- Helfer ----------------------------------------------------------------
const fmtTime = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtPrecise = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const fmtBytes = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.round(b / 1024)} KB`);
const fmtDate = (ms) => {
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Heute ${t}`;
  const y = new Date(now - 864e5);
  if (d.toDateString() === y.toDateString()) return `Gestern ${t}`;
  return `${d.toLocaleDateString('de-DE')} ${t}`;
};
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.innerHTML = `<use href="#i-${id}"/>`; return s; };
const setRange = (el) => { el.style.setProperty('--p', `${((el.value - el.min) / (el.max - el.min)) * 100}%`); };

function toast(message, kind = 'info') {
  const t = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

function beep() {
  try {
    const ctx = new AudioContext();
    [[880, 0], [1320, 0.11]].forEach(([f, at]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + at;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.start(t); o.stop(t + 0.14);
    });
    setTimeout(() => ctx.close(), 600);
  } catch { /* ohne Ton */ }
}

// Eigene Dialoge (window.prompt gibt es in Electron nicht)
function dialog({ title, text = '', input = null, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const m = $('#dialog'), inp = $('#dlgInput');
    $('#dlgTitle').textContent = title; $('#dlgText').textContent = text;
    inp.hidden = input === null; inp.value = input ?? '';
    $('#dlgOk').textContent = ok; $('#dlgOk').style.background = danger ? 'linear-gradient(135deg,#ff4d6d,#c026d3)' : '';
    m.hidden = false;
    if (input !== null) setTimeout(() => { inp.focus(); inp.select(); }, 30);
    const done = (v) => { m.hidden = true; $('#dlgOk').onclick = $('#dlgCancel').onclick = inp.onkeydown = null; resolve(v); };
    $('#dlgOk').onclick = () => done(input !== null ? inp.value : true);
    $('#dlgCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') $('#dlgOk').click(); if (e.key === 'Escape') done(null); };
  });
}

// ---- Navigation ------------------------------------------------------------
function go(page) {
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  if (page === 'clips' || page === 'home') loadClips();
  if (page === 'settings') refreshSettingsLists();
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-page]');
  if (t) go(t.dataset.page);
});

// ---- Übersicht -------------------------------------------------------------
function renderState() {
  if (!state) return;
  const s = state;
  const hero = $('#hero');
  let cls = '', title, sub;
  if (s.error) { cls = 'err'; title = 'Aufnahme-Problem'; sub = s.error; }
  else if (s.recording) {
    cls = 'on'; title = 'Aufnahme läuft';
    sub = s.game ? `Spiel erkannt: ${s.game.replace(/\.exe$/i, '')}` : s.mode === 'always' ? 'Immer-Modus aktiv' : 'Manuell gestartet';
  } else if (s.desired) { cls = 'wait'; title = 'Aufnahme startet …'; sub = 'Bildschirm wird verbunden.'; }
  else if (s.mode === 'auto' && s.override === null) { cls = 'wait'; title = 'Wartet auf ein Spiel'; sub = 'Sobald ein Spiel aus deiner Liste startet, geht es automatisch los.'; }
  else { title = 'Pausiert'; sub = 'Es wird nichts aufgenommen.'; }
  hero.className = `hero card ${cls}`;
  $('#heroTitle').textContent = title; $('#heroSub').textContent = sub;
  const tr = $('#toggleRec');
  tr.querySelector('span').textContent = s.desired ? 'Pausieren' : 'Jetzt starten';
  tr.querySelector('use').setAttribute('href', s.desired ? '#i-pause' : '#i-play');

  const pill = $('#sidePill');
  pill.className = `pill ${s.recording ? 'on' : (cls === 'wait' ? 'wait' : '')}`;
  pill.querySelector('span').textContent = s.recording ? 'Nimmt auf' : cls === 'wait' ? 'Bereit' : 'Pausiert';

  $('#bufNow').textContent = fmtTime(s.bufferSeconds);
  $('#bufMax').textContent = fmtTime(s.bufferMax);
  $('#meterFill').style.width = `${Math.min(100, (s.bufferSeconds / s.bufferMax) * 100)}%`;
  $('#bufSize').textContent = `${fmtBytes(s.bufferBytes)} Zwischenspeicher`;
  const encNames = { nvenc: 'NVIDIA NVENC', amd: 'AMD AMF', qsv: 'Intel QuickSync', x264: 'CPU (x264)',
    h264_nvenc: 'NVIDIA NVENC', h264_amf: 'AMD AMF', h264_qsv: 'Intel QuickSync', libx264: 'CPU (x264)' };
  const cap = s.capture;
  const chip = $('#encChip');
  if (cap) {
    const soft = cap.enc === 'x264';
    chip.textContent = `Aufnahme: ${encNames[cap.enc]}${soft ? ' – belastet die CPU' : ' (GPU)'}`;
    chip.style.color = soft ? 'var(--warn)' : 'var(--ok)';
  } else {
    const gpu = s.gpuEncoder === undefined ? undefined : s.gpuEncoder;
    chip.textContent = gpu === undefined ? 'Encoder wird geprüft …' : gpu ? `Grafikkarte: ${encNames[gpu]}` : 'Keine Grafikkarten-Encoder gefunden';
    chip.style.color = gpu === null ? 'var(--warn)' : '';
  }
  const gpuName = s.gpuEncoder ? encNames[s.gpuEncoder] : (s.gpuEncoder === undefined && s.hwEncoder ? encNames[s.hwEncoder] : null);
  $('#encHint').textContent = gpuName
    ? `Erkannt: ${gpuName}. „Automatisch“ nutzt die Grafikkarte für die Aufnahme – kaum FPS-Verlust.`
    : 'Keine Hardware-Encoder gefunden – der Prozessor wird genutzt (kann FPS kosten).';
  let noticeEl = $('#notice');
  const msg = !s.obsAvailable ? 'Aufnahme-Modul (OBS) fehlt – bitte Clipper neu installieren.' : s.notice;
  if (msg) {
    if (!noticeEl) { noticeEl = h('div', { id: 'notice', class: 'notice' }); $('#hero').after(noticeEl); }
    noticeEl.textContent = msg;
  } else if (noticeEl) noticeEl.remove();
  renderDiag(s);
  const max = Math.max(5, Math.floor(s.bufferSeconds));
  const slider = $('#clipLen');
  slider.max = Math.max(max, 6);
  slider.disabled = s.bufferSeconds < 5;
  clipSeconds = Math.min(clipWish, max);
  slider.value = clipSeconds; setRange(slider);
  $('#clipLenLabel').textContent = fmtTime(clipSeconds);
  $('#makeClip').disabled = s.bufferSeconds < 3;
}

function diagText(s) {
  const d = s.diag || {};
  const st = d.stats;
  return [
    `Plattform: ${d.platform} | Grafikkarten-Encoder: ${d.hw || 'keiner'} | OBS: ${d.obs || 'nicht gefunden'}`,
    `Aktiv: ${s.recording ? 'ja' : 'nein'} | Plan: ${d.plan ? `${d.plan.mode}/${d.plan.id}` : '–'} | Entlastungsstufe: ${d.degrade}`,
    st ? `OBS: CPU ${st.cpu.toFixed(1)} % | RAM ${Math.round(st.memMB)} MB | ${st.fps.toFixed(1)} FPS | Render ${st.renderMs.toFixed(1)} ms | verpasste Render-Frames ${st.renderSkipped}/${st.renderTotal} | verworfene Ausgabe-Frames ${st.outSkipped}/${st.outTotal}` : 'OBS: –',
    d.log ? `Log:\n${d.log}` : '',
  ].filter(Boolean).join('\n');
}
function renderDiag(s) { if ($('#page-settings').classList.contains('active')) $('#diagBox').textContent = diagText(s); }
$('#diagCopy').onclick = () => { navigator.clipboard.writeText(diagText(state)); toast('Diagnose kopiert', 'success'); };
$('#toggleRec').onclick = async () => { state = await api.toggleRecording(); renderState(); };
$('#clipLen').oninput = (e) => { clipWish = clipSeconds = Number(e.target.value); $('#clipLenLabel').textContent = fmtTime(clipSeconds); setRange(e.target); };
$('#quick').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  clipWish = Number(b.dataset.s);
  renderState();
};
$('#makeClip').onclick = async () => {
  try { await api.createClip(clipSeconds); } catch { /* Toast kommt vom Hauptprozess */ }
};

// ---- Clips -----------------------------------------------------------------
async function loadClips() {
  clips = await api.listClips();
  $('#clipCount').textContent = clips.length || '';
  renderClips();
}
function clipCard(c, compact = false) {
  const badge = h('span', { class: 'badge' }, '–:––');
  const v = document.createElement('video');
  v.preload = 'metadata'; v.src = c.url;
  v.onloadedmetadata = () => { badge.textContent = fmtTime(v.duration); v.removeAttribute('src'); v.load(); };
  const thumb = h('div', { class: 'thumb', style: c.thumb ? `background-image:url("${c.thumb}")` : '', onclick: () => openEditor(c) },
    h('div', { class: 'play' }, icon('play')), badge);
  const body = h('div', { class: 'clip-body' },
    h('div', { class: 'clip-name', title: c.name }, c.name),
    h('div', { class: 'clip-meta' }, `${fmtDate(c.mtime)} · ${fmtBytes(c.size)}`));
  const acts = compact ? null : h('div', { class: 'clip-actions' },
    h('button', { class: 'icon-btn', title: 'Ansehen & schneiden', onclick: () => openEditor(c) }, icon('scissors')),
    h('button', { class: 'icon-btn', title: 'Im Ordner zeigen', onclick: () => api.showInFolder(c.file) }, icon('folder')),
    h('button', { class: 'icon-btn', title: 'Umbenennen', onclick: () => renameClip(c) }, icon('edit')),
    h('button', { class: 'icon-btn danger', title: 'Löschen', onclick: () => deleteClip(c) }, icon('trash')));
  return h('div', { class: 'clip' }, thumb, body, acts);
}
function renderClips() {
  const grid = $('#clipGrid');
  grid.replaceChildren(...clips.map((c) => clipCard(c)));
  $('#clipsEmpty').hidden = clips.length > 0;
  $('#clipsSub').textContent = clips.length ? `${clips.length} Clip${clips.length === 1 ? '' : 's'} · ${fmtBytes(clips.reduce((a, c) => a + c.size, 0))}` : 'Deine gespeicherten Momente.';
  const strip = $('#recentStrip');
  strip.replaceChildren(...(clips.length ? clips.slice(0, 4).map((c) => clipCard(c, true)) : [h('p', { class: 'hint' }, 'Noch nichts geclippt – drück deinen Hotkey im Spiel.')]));
}
async function renameClip(c) {
  const name = await dialog({ title: 'Clip umbenennen', input: c.name, ok: 'Umbenennen' });
  if (!name || name === c.name) return;
  try { await api.renameClip(c.file, name); } catch (e) { toast(e.message.replace(/^.*Error: /, ''), 'error'); }
}
async function deleteClip(c) {
  const ok = await dialog({ title: 'Clip löschen?', text: `„${c.name}“ wird in den Papierkorb verschoben.`, ok: 'Löschen', danger: true });
  if (ok) api.deleteClip(c.file).catch((e) => toast(e.message, 'error'));
}
$('#openFolder').onclick = () => api.openClipsFolder();

// ---- Editor (Ansehen + Schneiden) -----------------------------------------
const ed = { clip: null, dur: 0, start: 0, end: 0, stopAt: null };
const video = $('#edVideo');
function openEditor(c) {
  ed.clip = c; ed.dur = 0; ed.start = 0; ed.end = 0; ed.stopAt = null;
  $('#edTitle').textContent = c.name;
  video.src = c.url;
  $('#editor').hidden = false;
  video.onloadedmetadata = () => { ed.dur = video.duration; ed.end = ed.dur; drawTrim(); video.play().catch(() => {}); };
}
function closeEditor() { video.pause(); video.removeAttribute('src'); video.load(); $('#editor').hidden = true; }
function drawTrim() {
  if (!ed.dur) return;
  const p = (t) => `${(t / ed.dur) * 100}%`;
  $('#hStart').style.left = p(ed.start); $('#hEnd').style.left = p(ed.end);
  const r = $('#trimRange'); r.style.left = p(ed.start); r.style.width = `${((ed.end - ed.start) / ed.dur) * 100}%`;
  $('#tStart').textContent = fmtPrecise(ed.start); $('#tEnd').textContent = fmtPrecise(ed.end);
  $('#tLen').textContent = fmtPrecise(ed.end - ed.start);
  $('#trimPlay').style.left = p(video.currentTime || 0);
  $('#edSave').disabled = ed.end - ed.start < 0.5 || (ed.start < 0.05 && ed.end > ed.dur - 0.05);
}
video.ontimeupdate = () => {
  $('#trimPlay').style.left = `${(video.currentTime / (ed.dur || 1)) * 100}%`;
  if (ed.stopAt !== null && video.currentTime >= ed.stopAt) { video.pause(); ed.stopAt = null; }
};
function dragHandle(el, which) {
  el.onpointerdown = (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    const track = $('#trimTrack').getBoundingClientRect();
    el.onpointermove = (ev) => {
      const t = Math.min(ed.dur, Math.max(0, ((ev.clientX - track.left) / track.width) * ed.dur));
      if (which === 'start') ed.start = Math.min(t, ed.end - 0.5); else ed.end = Math.max(t, ed.start + 0.5);
      video.currentTime = which === 'start' ? ed.start : Math.max(ed.start, ed.end - 0.05);
      drawTrim();
    };
    el.onpointerup = () => { el.onpointermove = el.onpointerup = null; };
  };
}
dragHandle($('#hStart'), 'start'); dragHandle($('#hEnd'), 'end');
$('#trimTrack').onpointerdown = (e) => {
  if (e.target.classList.contains('trim-handle')) return;
  const r = $('#trimTrack').getBoundingClientRect();
  video.currentTime = ((e.clientX - r.left) / r.width) * ed.dur;
};
$('#edPreview').onclick = () => { video.currentTime = ed.start; ed.stopAt = ed.end; video.play(); };
$('#edClose').onclick = closeEditor;
$('#editor').addEventListener('pointerdown', (e) => { if (e.target.id === 'editor') closeEditor(); });
$('#edSave').onclick = async () => {
  const btn = $('#edSave'); btn.disabled = true;
  const { clip, start, end } = { clip: ed.clip, start: ed.start, end: ed.end };
  closeEditor();
  try { await api.trimClip({ file: clip.file, start, end }); } catch { /* Toast vom Hauptprozess */ }
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#editor').hidden && $('#dialog').hidden) closeEditor(); });

// ---- Einstellungen ---------------------------------------------------------
async function save(patch) {
  settings = await api.setSettings(patch);
  syncSettings();
}
function bindSelect(id, num = false) {
  $(`#s-${id}`).onchange = (e) => save({ [id]: num ? Number(e.target.value) : e.target.value });
}
function bindSeg(id, num = false) {
  $(`#s-${id}`).onclick = (e) => { const b = e.target.closest('button'); if (b) save({ [id]: num ? Number(b.dataset.v) : b.dataset.v }); };
}
function bindToggle(id) { $(`#s-${id}`).onchange = (e) => save({ [id]: e.target.checked }); }
function bindRange(id, out, fmt) {
  const el = $(`#s-${id}`);
  el.oninput = () => { $(out).textContent = fmt(el.value); setRange(el); };
  el.onchange = () => save({ [id]: Number(el.value) });
}
bindSeg('mode'); bindSeg('fps', true);
bindSelect('screenIndex', true); bindSelect('captureMode'); bindSelect('resolution'); bindSelect('encoder'); bindSelect('hotkeySeconds', true);
['systemAudio', 'micAudio', 'beep', 'notify', 'openAtLogin', 'startHidden'].forEach(bindToggle);
bindRange('bufferMinutes', '#o-buffer', (v) => `${v} min`);
bindRange('bitrateMbps', '#o-bitrate', (v) => `${v} Mbit/s`);

function syncSettings() {
  const s = settings;
  $$('#s-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.mode));
  $$('#s-fps button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === s.fps));
  for (const id of ['resolution', 'encoder', 'hotkeySeconds']) $(`#s-${id}`).value = s[id];
  for (const id of ['systemAudio', 'micAudio', 'beep', 'notify', 'openAtLogin', 'startHidden']) $(`#s-${id}`).checked = s[id];
  $('#s-bufferMinutes').value = s.bufferMinutes; $('#o-buffer').textContent = `${s.bufferMinutes} min`; setRange($('#s-bufferMinutes'));
  $('#s-bitrateMbps').value = s.bitrateMbps; $('#o-bitrate').textContent = `${s.bitrateMbps} Mbit/s`; setRange($('#s-bitrateMbps'));
  const gb = ((s.bitrateMbps + 0.16) * 60 * s.bufferMinutes) / 8 / 1024;
  $('#diskHint').textContent = `Belegt ca. ${gb.toFixed(1)} GB temporären Speicher bei ${s.bufferMinutes} min Puffer.`;
  $('#s-hotkey').textContent = s.hotkey || 'Nicht belegt';
  $('#hotkeyHint').textContent = s.hotkey || '–';
  $('#dirLabel').textContent = s.clipsDir;
  $('#s-notify').closest('.row-set').querySelector('span').textContent = 'Kleine Meldung, sobald ein Clip fertig ist.';
  renderGames();
}

async function refreshSettingsLists() {
  const screens = await api.listScreens();
  const sel = $('#s-screenIndex');
  sel.replaceChildren(...screens.map((sc) => h('option', { value: sc.index }, `${sc.name} – ${sc.width}×${sc.height}${sc.primary ? ' (Hauptbildschirm)' : ''}`)));
  const primary = screens.find((x) => x.primary) || screens[0];
  sel.value = screens.some((x) => x.index === settings.screenIndex) ? settings.screenIndex : (primary ? primary.index : 0);
  const procs = await api.listProcesses();
  $('#procList').replaceChildren(...procs.filter((p) => p.endsWith('.exe')).map((p) => h('option', { value: p })));
}

function renderGames() {
  const live = state && state.game;
  $('#gameTags').replaceChildren(...[...settings.games].sort().map((g) => h('span', { class: `tag${live === g ? ' live' : ''}` }, g,
    h('button', { title: 'Entfernen', onclick: () => save({ games: settings.games.filter((x) => x !== g) }) }, icon('x')))));
}
function addGame() {
  const v = $('#gameInput').value.trim().toLowerCase();
  if (!v) return;
  const name = v.endsWith('.exe') ? v : `${v}.exe`;
  if (!settings.games.includes(name)) save({ games: [...settings.games, name] });
  $('#gameInput').value = '';
}
$('#addGame').onclick = addGame;
$('#gameInput').onkeydown = (e) => { if (e.key === 'Enter') addGame(); };
$('#resetGames').onclick = async () => {
  if (await dialog({ title: 'Standardliste wiederherstellen?', text: 'Deine eigenen Einträge werden ersetzt.', ok: 'Wiederherstellen' })) {
    save({ games: await api.defaultGames() });
  }
};
$('#pickDir').onclick = async () => { const dir = await api.pickFolder(); if (dir) save({ clipsDir: dir }); };

// Hotkey aufnehmen
function accelFromEvent(e) {
  const k = e.code;
  let key = null;
  if (/^F\d{1,2}$/.test(k)) key = k;
  else if (/^Key[A-Z]$/.test(k)) key = k.slice(3);
  else if (/^Digit\d$/.test(k)) key = k.slice(5);
  else if (/^Numpad\d$/.test(k)) key = `num${k.slice(6)}`;
  else key = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Backquote: '`', Minus: '-', Equal: '=' }[k] || null;
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!mods.length && !/^F\d/.test(key)) return null; // einzelne Zeichentasten wären im Spiel/Chat störend
  return [...mods, key].join('+');
}
$('#s-hotkey').onclick = () => {
  const btn = $('#s-hotkey');
  btn.classList.add('listening'); btn.textContent = 'Taste drücken …  (Esc = abbrechen)';
  const onKey = (e) => {
    e.preventDefault();
    if (e.key === 'Escape') { stop(); syncSettings(); return; }
    const acc = accelFromEvent(e);
    if (acc) { stop(); save({ hotkey: acc }); }
  };
  const stop = () => { btn.classList.remove('listening'); window.removeEventListener('keydown', onKey, true); };
  window.addEventListener('keydown', onKey, true);
};

// ---- Export-Fortschritt ----------------------------------------------------
const progress = new Map();
api.onExportProgress(({ id, label, progress: p, done }) => {
  let el = progress.get(id);
  if (done) { if (el) { el.remove(); progress.delete(id); } return; }
  if (!el) { el = h('div', { class: 'prog' }, h('span', {}), h('div', { class: 'bar' }, h('i'))); progress.set(id, el); $('#progressDock').append(el); }
  el.querySelector('span').textContent = `${label} ${Math.round(p * 100)} %`;
  el.querySelector('i').style.width = `${Math.round(p * 100)}%`;
});

// ---- Verdrahtung -----------------------------------------------------------
api.onState((s) => { state = s; renderState(); if ($('#page-settings').classList.contains('active')) renderGames(); });
api.onToast(({ message, kind }) => toast(message, kind));
api.onNavigate(go);
api.onClipsChanged(loadClips);
api.onClipSaved((info) => {
  if (settings && settings.beep) beep();
  toast(`Clip gespeichert: ${info.name}`, 'success');
});

(async function init() {
  settings = await api.getSettings();
  state = await api.getState();
  syncSettings();
  renderState();
  loadClips();
  api.rendererReady();
})();
