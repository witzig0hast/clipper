'use strict';
/**
 * Ton-Aufnahme im Renderer: System-Audio/Mikrofon wird in kurzen, leicht überlappenden
 * WebM-Segmenten an den Hauptprozess übergeben (das Bild nimmt ffmpeg auf).
 */
const Recorder = (() => {
  const SEG_MS = 10000;      // Länge eines Segments
  const OVERLAP_MS = 600;    // Überlappung zum nächsten Segment (lückenloser Übergang)

  let stream = null;         // Roh-Stream (Bildschirm + Loopback)
  let recordStream = null;   // was tatsächlich aufgenommen wird
  let extra = [];            // Mikrofon-Stream
  let audioCtx = null;
  let timer = null;
  let running = false;
  let mime = null;
  let cfg = null;
  let cfgKey = '';
  let nextId = Date.now();
  const active = new Map();
  let queue = Promise.resolve();

  const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));

  // Bild kommt aus ffmpeg (Hardware-Encoder). Hier wird nur der Ton aufgenommen:
  // System-Audio (Loopback) und/oder Mikrofon.
  async function buildRecordStream(c) {
    const tracks = [];
    if (c.systemAudio) {
      let s;
      try {
        s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch {
        s = await navigator.mediaDevices.getUserMedia({
          video: { mandatory: { chromeMediaSource: 'desktop' } },
          audio: { mandatory: { chromeMediaSource: 'desktop' } },
        });
      }
      s.getVideoTracks().forEach((t) => t.stop()); // Bildaufnahme sofort beenden – spart GPU
      stream = s;
      tracks.push(...s.getAudioTracks());
    }
    let mic = null;
    if (c.micAudio) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: c.micDeviceId ? { exact: c.micDeviceId } : undefined, echoCancellation: false, noiseSuppression: true },
        });
        extra.push(mic);
      } catch { /* Mikro nicht verfügbar */ }
    }
    if (!tracks.length && !mic) throw new Error('Keine Audioquelle verfügbar.');
    if (tracks.length && !mic) return new MediaStream(tracks);
    if (!tracks.length) return mic;
    audioCtx = new AudioContext({ sampleRate: 48000 });
    const dest = audioCtx.createMediaStreamDestination();
    audioCtx.createMediaStreamSource(new MediaStream(tracks)).connect(dest);
    audioCtx.createMediaStreamSource(mic).connect(dest);
    return dest.stream;
  }

  async function sendSegment(seg, partial) {
    if (!seg.chunks.length) return;
    const endedAt = partial ? Date.now() : seg.endedAt;
    const buf = await new Blob(seg.chunks, { type: mime }).arrayBuffer();
    await window.api.saveSegment({ id: seg.id, startedAt: seg.startedAt, endedAt, partial }, buf);
  }

  function startSegment() {
    if (!running) return;
    const seg = { id: nextId++, startedAt: Date.now(), endedAt: 0, chunks: [], rec: null, timeout: null };
    let resolveDone;
    seg.done = new Promise((r) => { resolveDone = r; });
    try {
      seg.rec = new MediaRecorder(recordStream, { mimeType: mime, audioBitsPerSecond: 160000 });
    } catch (e) { fail(e); return; }
    seg.rec.ondataavailable = (e) => { if (e.data && e.data.size) seg.chunks.push(e.data); };
    seg.rec.onerror = (e) => fail(e.error || e);
    seg.rec.onstop = async () => {
      seg.endedAt = Date.now();
      try { await sendSegment(seg, false); } catch (e) { console.error(e); }
      active.delete(seg.id);
      resolveDone();
    };
    seg.rec.start(1000);
    seg.timeout = setTimeout(() => { if (seg.rec.state !== 'inactive') seg.rec.stop(); }, SEG_MS + OVERLAP_MS);
    active.set(seg.id, seg);
  }

  function fail(e) {
    const msg = (e && (e.message || e.name)) || String(e);
    window.api.reportRecorder({ active: false, error: msg });
    queue = queue.then(() => doStop());
  }

  async function doStart(config) {
    const key = JSON.stringify(config);
    if (running && key === cfgKey) return;
    await doStop();
    cfg = config; cfgKey = key;
    if (!config.systemAudio && !config.micAudio) return; // stumm aufnehmen
    mime = pickMime();
    if (!mime) { window.api.reportRecorder({ active: false, error: 'Kein unterstütztes Audio-Format verfügbar.' }); return; }
    try {
      recordStream = await buildRecordStream(config);
    } catch (e) {
      await doStop();
      window.api.reportRecorder({ active: false, error: e.message || String(e) });
      return;
    }
    running = true;
    startSegment();
    timer = setInterval(startSegment, SEG_MS);
    window.api.reportRecorder({ active: true });
  }

  async function doStop() {
    const wasRunning = running;
    running = false;
    cfgKey = '';
    clearInterval(timer); timer = null;
    const segs = [...active.values()];
    for (const s of segs) {
      clearTimeout(s.timeout);
      if (s.rec && s.rec.state !== 'inactive') { try { s.rec.stop(); } catch { /* egal */ } }
    }
    await Promise.all(segs.map((s) => s.done));
    for (const t of [...(stream ? stream.getTracks() : []), ...extra.flatMap((m) => m.getTracks())]) t.stop();
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    stream = recordStream = null; extra = [];
    if (wasRunning) window.api.reportRecorder({ active: false });
  }

  /** Aktuell laufende Segmente als Teilstück an den Hauptprozess geben. */
  async function flush() {
    const segs = [...active.values()].filter((s) => s.rec && s.rec.state === 'recording');
    await Promise.all(segs.map(async (s) => {
      const stamp = Date.now();
      await new Promise((resolve) => {
        s.rec.addEventListener('dataavailable', () => resolve(), { once: true });
        try { s.rec.requestData(); } catch { resolve(); }
      });
      const buf = await new Blob(s.chunks, { type: mime }).arrayBuffer();
      if (buf.byteLength) {
        await window.api.saveSegment({ id: s.id, startedAt: s.startedAt, endedAt: stamp, partial: true }, buf);
      }
    }));
  }

  return {
    start: (c) => (queue = queue.then(() => doStart(c))),
    stop: () => (queue = queue.then(() => doStop())),
    flush,
  };
})();
