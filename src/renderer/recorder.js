'use strict';
/**
 * Dauer-Aufnahme im Renderer: Bildschirm (+System-Audio/Mikro) wird in kurzen,
 * leicht überlappenden WebM-Segmenten an den Hauptprozess übergeben, der daraus
 * den Ringpuffer baut.
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

  const pickMime = () => [
    'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus', 'video/webm',
  ].find((t) => MediaRecorder.isTypeSupported(t));

  function videoConstraints(c) {
    const v = { frameRate: { ideal: c.fps, max: c.fps } };
    if (c.resolution !== 'native') {
      const h = Number(c.resolution);
      v.height = { max: h };
      v.width = { max: Math.round((h * 16) / 9) };
    }
    return v;
  }

  async function captureStream(c) {
    try {
      // Hauptprozess liefert Bildschirm + Loopback-Audio (setDisplayMediaRequestHandler)
      return await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints(c), audio: c.systemAudio });
    } catch (e1) {
      // Fallback: klassische desktop-Capture-Constraints
      const screens = await window.api.listScreens();
      const src = screens.find((s) => s.id === c.screenId) || screens.find((s) => s.primary) || screens[0];
      if (!src) throw e1;
      const v = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxFrameRate: c.fps } };
      if (c.resolution !== 'native') {
        v.mandatory.maxHeight = Number(c.resolution);
        v.mandatory.maxWidth = Math.round((Number(c.resolution) * 16) / 9);
      }
      return navigator.mediaDevices.getUserMedia({
        video: v,
        audio: c.systemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      });
    }
  }

  async function buildRecordStream(c) {
    const video = stream.getVideoTracks()[0];
    const sysAudio = stream.getAudioTracks();
    if (!c.micAudio) return new MediaStream([video, ...sysAudio]);
    let mic = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: c.micDeviceId ? { exact: c.micDeviceId } : undefined, echoCancellation: false, noiseSuppression: true },
      });
      extra.push(mic);
    } catch { /* Mikro nicht verfügbar -> ohne */ }
    if (!mic && sysAudio.length) return new MediaStream([video, ...sysAudio]);
    audioCtx = new AudioContext({ sampleRate: 48000 });
    const dest = audioCtx.createMediaStreamDestination();
    if (sysAudio.length) audioCtx.createMediaStreamSource(new MediaStream(sysAudio)).connect(dest);
    if (mic) audioCtx.createMediaStreamSource(mic).connect(dest);
    return new MediaStream([video, ...dest.stream.getAudioTracks()]);
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
      seg.rec = new MediaRecorder(recordStream, {
        mimeType: mime,
        videoBitsPerSecond: Math.round(cfg.bitrateMbps * 1e6),
        audioBitsPerSecond: 160000,
      });
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
    mime = pickMime();
    if (!mime) { window.api.reportRecorder({ active: false, error: 'Kein unterstütztes Video-Format verfügbar.' }); return; }
    try {
      stream = await captureStream(config);
      recordStream = await buildRecordStream(config);
    } catch (e) {
      await doStop();
      window.api.reportRecorder({ active: false, error: e.message || String(e) });
      return;
    }
    stream.getVideoTracks()[0].addEventListener('ended', () => fail(new Error('Bildschirmaufnahme wurde beendet.')));
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
