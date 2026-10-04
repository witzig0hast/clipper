'use strict';

/**
 * Der Ringpuffer besteht aus vielen kurzen WebM-Segmenten. Aufeinanderfolgende
 * Segmente überlappen sich leicht (damit beim Wechsel nichts verloren geht).
 * Diese Funktionen berechnen, welcher Teil jedes Segments "gültig" ist und
 * welche Segmente für einen Clip der letzten N Sekunden gebraucht werden.
 */

/** @typedef {{id:number,file:string,startedAt:number,endedAt:number}} Segment */

/** Liefert Segmente mit nutzbarem Zeitfenster [from, to) in ms (Epoch). */
function usableIntervals(segments) {
  const sorted = [...segments]
    .filter((s) => s.endedAt > s.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  return sorted.map((s, i) => {
    const next = sorted[i + 1];
    const to = next ? Math.min(next.startedAt, s.endedAt) : s.endedAt;
    return { ...s, from: s.startedAt, to };
  });
}

/** Ende des aktuell aufgenommenen Materials (ms) oder null. */
function bufferEnd(segments) {
  const iv = usableIntervals(segments);
  return iv.length ? Math.max(...iv.map((s) => s.to)) : null;
}

/** Gesamtlänge des gepufferten Materials in Sekunden (Lücken zählen nicht). */
function bufferedSeconds(segments) {
  return usableIntervals(segments).reduce((sum, s) => sum + Math.max(0, s.to - s.from), 0) / 1000;
}

/**
 * Plant einen Clip aus den letzten `seconds` Sekunden.
 * Rückgabe: Liste {file, inpoint, outpoint} (Sekunden) + tatsächliche Dauer.
 */
function planClip(segments, seconds) {
  const iv = usableIntervals(segments);
  if (!iv.length) return { parts: [], duration: 0 };
  const end = Math.max(...iv.map((s) => s.to));
  const start = end - seconds * 1000;
  const parts = [];
  for (const s of iv) {
    if (s.to <= start || s.to - s.from < 50) continue;
    const inpoint = Math.max(0, start - s.from) / 1000;
    const outpoint = (s.to - s.from) / 1000;
    if (outpoint - inpoint < 0.05) continue;
    parts.push({ file: s.file, inpoint, outpoint });
  }
  const duration = parts.reduce((sum, p) => sum + (p.outpoint - p.inpoint), 0);
  return { parts, duration };
}

/**
 * Teile, die das Zeitfenster [ws, we] (ms, Wanduhr) abdecken.
 * outpoint kürzt jedes Segment auf seinen nutzbaren Bereich; firstFrom = Wanduhrzeit,
 * ab der das erste Segment Material liefert.
 */
function planWindow(segments, ws, we) {
  const parts = [];
  let firstFrom = null;
  for (const s of usableIntervals(segments)) {
    if (s.to <= ws || s.from >= we) continue;
    const outpoint = (Math.min(s.to, we) - s.from) / 1000;
    if (outpoint < 0.05) continue;
    if (firstFrom === null) firstFrom = s.from;
    parts.push({ file: s.file, outpoint });
  }
  return { parts, firstFrom };
}

/** Segmente, die älter als das Puffer-Limit sind. */
function expiredSegments(segments, keepSeconds, slackSeconds = 20) {
  const end = bufferEnd(segments);
  if (end == null) return [];
  const limit = end - (keepSeconds + slackSeconds) * 1000;
  return segments.filter((s) => s.endedAt < limit);
}

module.exports = { planWindow, usableIntervals, bufferEnd, bufferedSeconds, planClip, expiredSegments };
