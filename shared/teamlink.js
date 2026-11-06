// Team-Link: Stint-Plan und Live-Daten im Team teilen – ohne eigenen Server, ohne Konto.
//
// Übertragung: öffentliche MQTT-Vermittler (über WebSocket), mehrere gleichzeitig. Die Vermittler sehen nur
// zufällige Themen-Namen und verschlüsselte Daten.
//   • Raum-Schlüssel (16 Byte, im Link): daraus der Themen-Name und der AES-GCM-Schlüssel (Ende-zu-Ende).
//   • Bearbeiten-Schlüssel (ECDSA P-256): Jede Änderung am Plan und jede Live-Meldung ist signiert. Der
//     Ansichts-Link enthält nur den öffentlichen Schlüssel – damit lässt sich prüfen, aber nichts ändern.
//   • Links: …/team/#bearbeiten=<raum>.<privat>.<x>.<y>  bzw.  …/team/#ansicht=<raum>.<x>.<y>
//     Der Teil nach «#» wird vom Browser nie an einen Server geschickt.
// Gemeinsam für den Core (Node, eigener WebSocket-Client) und die Team-Seite (Browser).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OMTeam = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const PAGE = 'https://xdect.github.io/OM-Pitwall-Releases/team/'; // öffentliches Release-Repository (der Code bleibt privat)
  const PREFIX = 'ompw1';
  const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ---------- Hilfen ----------
  function b64u(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const B64U = /^[A-Za-z0-9_-]+$/;
  const concat = (...parts) => {
    const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const sha = async (text) => new Uint8Array(await subtle().digest('SHA-256', enc.encode(text)));

  // ---------- Schlüssel und Links ----------
  async function createKeys() {
    const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const j = await subtle().exportKey('jwk', kp.privateKey);
    return { room: b64u(rnd(16)), sk: j.d, pk: { x: j.x, y: j.y } };
  }
  function links(keys, base) {
    const b = String(base || PAGE).replace(/#.*$/, '');
    return {
      edit: `${b}#bearbeiten=${keys.room}.${keys.sk}.${keys.pk.x}.${keys.pk.y}`,
      view: `${b}#ansicht=${keys.room}.${keys.pk.x}.${keys.pk.y}`,
    };
  }
  // Link (oder nur der Teil nach «#») lesen → { mode: 'edit' | 'view', room, sk?, pk } oder null
  function parseLink(text) {
    const m = /(?:^|#|&)(bearbeiten|ansicht)=([A-Za-z0-9_.-]+)/.exec(String(text || '').trim());
    if (!m) return null;
    const f = m[2].split('.');
    if (!f.every((x) => B64U.test(x))) return null;
    if (m[1] === 'bearbeiten' && f.length === 4 && f[0].length >= 16) return { mode: 'edit', room: f[0], sk: f[1], pk: { x: f[2], y: f[3] } };
    if (m[1] === 'ansicht' && f.length === 3 && f[0].length >= 16) return { mode: 'view', room: f[0], pk: { x: f[1], y: f[2] } };
    return null;
  }

  // ---------- MQTT 3.1.1 (nur was gebraucht wird: QoS 0, «retain») ----------
  const str = (s) => { const b = enc.encode(s); return concat(new Uint8Array([b.length >> 8, b.length & 255]), b); };
  function packet(type, flags, body) {
    const len = [];
    let n = body.length;
    do { let x = n % 128; n = Math.floor(n / 128); if (n > 0) x |= 128; len.push(x); } while (n > 0);
    return concat(new Uint8Array([(type << 4) | flags, ...len]), body);
  }
  const MQ = {
    connect: (id) => packet(1, 0, concat(str('MQTT'), new Uint8Array([4, 2, 0, 60]), str(id))),
    subscribe: (pid, topic) => packet(8, 2, concat(new Uint8Array([pid >> 8, pid & 255]), str(topic), new Uint8Array([0]))),
    publish: (topic, payload, retain) => packet(3, retain ? 1 : 0, concat(str(topic), payload)),
    ping: () => new Uint8Array([0xC0, 0]),
    disconnect: () => new Uint8Array([0xE0, 0]),
  };
  // Datenstrom in Pakete zerlegen
  function parser(onPacket) {
    let buf = new Uint8Array(0);
    return (chunk) => {
      buf = concat(buf, chunk);
      for (;;) {
        if (buf.length < 2) return;
        let len = 0, mul = 1, i = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128 && i < 5);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, flags = buf[0] & 15, body = buf.slice(i, i + len);
        buf = buf.slice(i + len);
        if (type === 3) {
          const tl = (body[0] << 8) | body[1];
          const topic = dec.decode(body.slice(2, 2 + tl));
          const off = 2 + tl + (((flags >> 1) & 3) > 0 ? 2 : 0);
          onPacket({ type, topic, payload: body.slice(off), retain: !!(flags & 1) });
        } else onPacket({ type, flags, body });
      }
    };
  }

  // Eine Verbindung zu einem Vermittler, mit automatischem Neuverbinden
  class Broker {
    constructor(url, WS, filter, onMsg, onState, onUp) {
      Object.assign(this, { url, WS, filter, onMsg, onState, onUp });
      this.state = 'connecting';
      this.retry = 2000;
      this.stopped = false;
      this.open();
    }
    set(st) { if (st !== this.state) { this.state = st; this.onState(); } }
    open() {
      if (this.stopped) return;
      let ws;
      try { ws = new this.WS(this.url, ['mqtt']); } catch { return this.later(); }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      const feed = parser((p) => {
        if (p.type === 2) { // CONNACK
          if (p.body[1] !== 0) { try { ws.close(); } catch { /* egal */ } return; }
          this.retry = 2000;
          this.send(MQ.subscribe(1, this.filter));
          this.set('ok');
          this.onUp(this);
        } else if (p.type === 3) this.onMsg(p.topic, p.payload, this);
      });
      ws.onopen = () => {
        this.send(MQ.connect('ompw' + b64u(rnd(9))));
        clearInterval(this.pinger);
        this.pinger = setInterval(() => this.send(MQ.ping()), 25000);
      };
      ws.onmessage = (e) => { if (e.data && typeof e.data !== 'string') feed(new Uint8Array(e.data)); };
      ws.onclose = () => { clearInterval(this.pinger); if (this.ws === ws) { this.ws = null; this.set('down'); this.later(); } };
      ws.onerror = () => { try { ws.close(); } catch { /* egal */ } };
    }
    later() {
      if (this.stopped) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(30000, this.retry * 2);
    }
    send(bytes) { if (this.ws && this.ws.readyState === 1) { try { this.ws.send(bytes); return true; } catch { /* egal */ } } return false; }
    publish(topic, payload, retain) { return this.state === 'ok' && this.send(MQ.publish(topic, payload, retain)); }
    stop() {
      this.stopped = true;
      clearTimeout(this.timer); clearInterval(this.pinger);
      const ws = this.ws;
      this.ws = null;
      if (ws) { try { ws.send(MQ.disconnect()); } catch { /* egal */ } try { ws.close(); } catch { /* egal */ } }
    }
  }

  // ---------- Raum ----------
  // opts: { keys: { room, pk, sk? }, WebSocket, brokers, role: 'app' | 'edit' | 'view', name }
  // Ereignisse (room.on): plan(doc), live(doc), peers(list), status()
  class TeamRoom {
    constructor(opts) {
      this.opts = opts;
      this.keys = opts.keys;
      this.canEdit = !!opts.keys.sk;
      this.role = opts.role || (this.canEdit ? 'edit' : 'view');
      this.id = /^[A-Za-z0-9_-]{6,24}$/.test(opts.sid || '') ? opts.sid : b64u(rnd(9)); // feste Kennung der App (Live-Meldung bleibt am selben Ort)
      this.handlers = {};
      this.brokers = [];
      this.plan = null;        // neuester gültiger Plan { doc, raw }
      this.lives = new Map();  // Absender → neueste Live-Meldung
      this.peers = new Map();  // Anwesende (id → { role, name, at })
      this.rejected = 0;       // verworfene Nachrichten (falsche Signatur, unlesbar)
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev, x) { for (const fn of this.handlers[ev] || []) { try { fn(x); } catch (e) { console.error('[Team]', e); } } }

    async start() {
      const k = this.keys;
      this.topic = `${PREFIX}/${b64u(await sha('ompw-room:' + k.room)).slice(0, 22)}`;
      this.aes = await subtle().importKey('raw', await sha('ompw-key:' + k.room), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const jwk = { kty: 'EC', crv: 'P-256', x: k.pk.x, y: k.pk.y, ext: true };
      this.verifyKey = await subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (this.canEdit) this.signKey = await subtle().importKey('jwk', { ...jwk, d: k.sk }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const list = (this.opts.brokers && this.opts.brokers.length ? this.opts.brokers : BROKERS).slice(0, 6);
      this.brokers = list.map((u) => new Broker(u, this.opts.WebSocket, this.topic + '/#', (t, p, b) => this.receive(t, p, b), () => this.emit('status'), (b) => this.up(b)));
      this.hiTimer = setInterval(() => this.hello(), 15000);
      return this;
    }
    // wipe (nur mit Bearbeiten-Schlüssel): Teilen beenden – statt des Plans liegt danach nur noch eine signierte
    // «beendet»-Meldung beim Vermittler (ohne Inhalt); offene Seiten zeigen «beendet» und stellen nichts wieder her
    async stop(wipe) {
      clearInterval(this.hiTimer);
      clearTimeout(this.repairTimer);
      if (wipe && this.canEdit && this.topic) {
        try {
          const prev = this.plan ? this.plan.doc.rev : 0;
          const raw = await this.seal({ k: 'plan', v: 1, rev: prev + 1000, ts: Date.now(), closed: true }, true);
          for (const b of this.brokers) {
            b.publish(this.topic + '/plan', raw, true);
            b.publish(`${this.topic}/live/${this.id}`, new Uint8Array(0), true);
          }
          await new Promise((r) => setTimeout(r, 150)); // senden lassen
        } catch { /* egal */ }
      }
      for (const b of this.brokers) b.stop();
      this.brokers = [];
    }
    status() {
      return { brokers: this.brokers.map((b) => ({ url: b.url, state: b.state })), online: this.brokers.filter((b) => b.state === 'ok').length,
        peers: this.peerList(), rev: this.plan ? this.plan.doc.rev : 0, rejected: this.rejected };
    }
    peerList() {
      const now = Date.now();
      return [...this.peers.entries()].filter(([, p]) => now - p.at < 45000).map(([id, p]) => ({ id, role: p.role, name: p.name }));
    }

    // Verbindung steht: anmelden und den neuesten bekannten Plan (unverändert, signiert) nachreichen
    up(b) {
      this.hello(b);
      if (this.plan && this.role !== 'view') b.publish(this.topic + '/plan', this.plan.raw, true);
    }
    async hello(only) {
      const raw = await this.seal({ k: 'hi', id: this.id, role: this.role, name: String(this.opts.name || '').slice(0, 40), ts: Date.now() });
      for (const b of only ? [only] : this.brokers) b.publish(this.topic + '/hi', raw, false);
      this.peers.set(this.id, { role: this.role, name: this.opts.name || '', at: Date.now() });
    }

    // ---------- Verschlüsseln / Signieren ----------
    async seal(doc, sign) {
      const d = JSON.stringify(doc);
      const env = { d };
      if (sign) env.s = b64u(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, this.signKey, enc.encode(d)));
      const iv = rnd(12);
      const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, this.aes, enc.encode(JSON.stringify(env))));
      return concat(new Uint8Array([1]), iv, ct);
    }
    async open(payload, needSig) {
      if (!payload || payload.length < 30 || payload[0] !== 1) return null;
      try {
        const pt = await subtle().decrypt({ name: 'AES-GCM', iv: payload.slice(1, 13) }, this.aes, payload.slice(13));
        const env = JSON.parse(dec.decode(pt));
        if (typeof env.d !== 'string' || env.d.length > 200000) return null;
        if (needSig) {
          if (typeof env.s !== 'string' || !B64U.test(env.s)) return null;
          const ok = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, this.verifyKey, unb64u(env.s), enc.encode(env.d));
          if (!ok) return null;
        }
        return JSON.parse(env.d);
      } catch { return null; }
    }

    async receive(topic, payload, from) {
      if (!topic.startsWith(this.topic + '/')) return;
      const kind = topic.slice(this.topic.length + 1).split('/')[0];
      if (!payload.length) return; // gelöscht
      if (kind === 'hi') {
        const d = await this.open(payload, false);
        if (d && d.k === 'hi' && typeof d.id === 'string') {
          const isNew = !this.peers.has(d.id) || Date.now() - this.peers.get(d.id).at > 45000;
          this.peers.set(d.id, { role: ['app', 'edit', 'view'].includes(d.role) ? d.role : 'view', name: String(d.name || '').slice(0, 40), at: Date.now() });
          if (isNew) this.emit('peers', this.peerList());
        }
        return;
      }
      if (kind === 'plan') {
        const d = await this.open(payload, true);
        if (!d || d.k !== 'plan' || !(d.rev >= 1) || (!d.plan && !d.closed)) { this.rejected++; this.repair(from); return; }
        const cur = this.plan && this.plan.doc;
        if (cur && cur.closed) { if (!d.closed) this.repair(from); return; } // beendet bleibt beendet
        if (!cur || d.closed || d.rev > cur.rev || (d.rev === cur.rev && d.ts > cur.ts)) {
          this.plan = { doc: d, raw: payload };
          this.emit(d.closed ? 'closed' : 'plan', d);
        } else if (d.rev < cur.rev) this.repair(from); // veralteter Stand beim Vermittler: neueren nachreichen
        return;
      }
      if (kind === 'live') {
        const d = await this.open(payload, true);
        if (!d || d.k !== 'live' || typeof d.sid !== 'string') { this.rejected++; return; }
        const cur = this.lives.get(d.sid);
        if (cur && cur.ts >= d.ts) return;
        this.lives.set(d.sid, d);
        this.emit('live', d);
      }
    }
    // Ungültiger oder veralteter Plan beim Vermittler: den neuesten gültigen wieder hinterlegen
    repair(b) {
      if (this.role === 'view' || !this.plan || !b) return;
      clearTimeout(this.repairTimer);
      this.repairTimer = setTimeout(() => b.publish(this.topic + '/plan', this.plan.raw, true), 300 + Math.random() * 1500);
    }

    // ---------- Senden ----------
    // Neuen Plan-Stand veröffentlichen: doc = { pid, plan, by } – Version zählt automatisch hoch
    async publishPlan(doc) {
      if (!this.canEdit) throw new Error('Nur mit dem Bearbeiten-Link');
      if (this.plan && this.plan.doc.closed) throw new Error('Das Teilen wurde beendet');
      const prev = this.plan ? this.plan.doc.rev : 0;
      const d = { k: 'plan', v: 1, rev: Math.max(prev, Number(doc.rev) || 0) + 1, ts: Date.now(), by: String(doc.by || '').slice(0, 40), pid: doc.pid || '', plan: doc.plan };
      const raw = await this.seal(d, true);
      this.plan = { doc: d, raw };
      for (const b of this.brokers) b.publish(this.topic + '/plan', raw, true);
      return d;
    }
    async publishLive(doc) {
      if (!this.canEdit) return null;
      const d = { ...doc, k: 'live', v: 1, sid: this.id, ts: Date.now() };
      const raw = await this.seal(d, true);
      for (const b of this.brokers) b.publish(`${this.topic}/live/${this.id}`, raw, true);
      this.lives.set(this.id, d);
      return d;
    }
  }

  return { BROKERS, PAGE, createKeys, links, parseLink, TeamRoom, b64u, unb64u, MQ, parser };
});
