'use strict';

/**
 * Clip der letzten `seconds` Sekunden aus einer Zeitleiste [{file,duration}] (älteste zuerst).
 * Rückgabe: Dateien in Reihenfolge, inpoint (Sekunden) nur für die erste, tatsächliche Dauer.
 */
function planTail(timeline, seconds) {
  const total = timeline.reduce((a, t) => a + t.duration, 0);
  let skip = Math.max(0, total - seconds);
  const parts = [];
  for (const t of timeline) {
    if (skip >= t.duration - 0.05) { skip -= t.duration; continue; }
    parts.push({ file: t.file, inpoint: parts.length ? 0 : skip, duration: t.duration });
    skip = 0;
  }
  const duration = parts.reduce((a, p) => a + p.duration - p.inpoint, 0);
  return { parts, duration };
}

module.exports = { planTail };
