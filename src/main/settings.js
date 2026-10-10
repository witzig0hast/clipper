'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DEFAULT_GAMES } = require('./games');

const defaults = () => ({
  mode: 'auto',            // auto = nur bei erkannten Spielen | always | manual
  bufferMinutes: 20,
  fps: 30,
  resolution: 'native',    // native | 1440 | 1080 | 720
  bitrateMbps: 12,
  systemAudio: true,
  micAudio: false,
  screenIndex: -1,           // -1 = Hauptbildschirm
  captureMode: 'auto',       // auto = Spiel + Bildschirm | game | display
  encoder: 'auto',         // auto = Grafikkarte wenn möglich | cpu
  games: DEFAULT_GAMES,
  hotkey: 'Alt+F10',
  hotkeySeconds: 30,
  clipsDir: path.join(app.getPath('videos'), 'Clipper'),
  beep: true,
  notify: true,
  openAtLogin: false,
  startHidden: false,
});

let current = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* erster Start */ }
  current = { ...defaults(), ...saved };
  return current;
}
function get() { return current || load(); }
function update(patch) {
  current = { ...get(), ...patch };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(current, null, 2));
  } catch (e) { console.error('Settings speichern fehlgeschlagen', e); }
  return current;
}

module.exports = { get, update, defaults };
