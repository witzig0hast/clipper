'use strict';
/** Minimaler obs-websocket-5-Client (Protokoll: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md). */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const b64sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64');

class ObsWs extends EventEmitter {
  constructor() {
    super();
    this.ws = null; this.pending = new Map(); this.connected = false;
  }

  connect(port, password, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'obswebsocket.json', { handshakeTimeout: timeoutMs });
      this.ws = ws;
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => { done(new Error('OBS-WebSocket: Zeitüberschreitung')); try { ws.terminate(); } catch { /* egal */ } }, timeoutMs);
      ws.on('error', (e) => done(e));
      ws.on('close', () => {
        this.connected = false;
        for (const p of this.pending.values()) p.reject(new Error('Verbindung zu OBS getrennt'));
        this.pending.clear();
        done(new Error('OBS-WebSocket geschlossen'));
        this.emit('close');
      });
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.op === 0) { // Hello
          const id = { rpcVersion: 1, eventSubscriptions: (1 << 6) | (1 << 5) }; // Outputs + Stats? (Outputs=1<<6)
          id.eventSubscriptions = 1 << 6;
          const a = m.d.authentication;
          if (a) id.authentication = b64sha256(b64sha256(password + a.salt) + a.challenge);
          ws.send(JSON.stringify({ op: 1, d: id }));
        } else if (m.op === 2) { // Identified
          this.connected = true; done();
        } else if (m.op === 7) { // RequestResponse
          const p = this.pending.get(m.d.requestId);
          if (!p) return;
          this.pending.delete(m.d.requestId);
          const st = m.d.requestStatus || {};
          if (st.result) p.resolve(m.d.responseData || {});
          else { const e = new Error(`OBS ${m.d.requestType}: ${st.comment || st.code}`); e.code = st.code; p.reject(e); }
        } else if (m.op === 5) {
          this.emit('event', m.d.eventType, m.d.eventData || {});
        }
      });
    });
  }

  request(type, data = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Nicht mit OBS verbunden'));
      const id = crypto.randomUUID();
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`OBS ${type}: Zeitüberschreitung`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data } }));
    });
  }

  close() { try { this.ws && this.ws.close(); } catch { /* egal */ } }
}

module.exports = { ObsWs };
