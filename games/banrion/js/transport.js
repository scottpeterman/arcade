// banrion/js/transport.js
//
// Banrion — 3D wireframe chess.  Copyright (C) 2026 Scott Peterman
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.  It is distributed WITHOUT ANY WARRANTY; without even
// the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
// PURPOSE.  See the GNU General Public License for more details.
// You should have received a copy of the GPL along with this program; if not,
// see <https://www.gnu.org/licenses/>.  Vendored components keep their own
// licences — see THIRD-PARTY-NOTICES.md.
//
// Pluggable message transport for two-player games. Lifted from the SFB build
// with one change: the namespace, KDF salt and client-id prefix are no longer
// hard-coded, so the same file serves both games. Different namespace + salt
// means an SFB code and a chess code can never collide on a shared broker.
//
//     Transport.configure({ ns, salt, clientPrefix })
//     Transport.host(code)          -> Promise, resolves when subscribed
//     Transport.join(code)          -> Promise, resolves when subscribed
//     Transport.send(obj)           -> RETAINED snapshot. Last one survives a
//                                      reconnect and is replayed on subscribe.
//     Transport.sendEvent(obj)      -> NON-retained, sequenced, deduped.
//                                      The chess build does not use this: its
//                                      snapshot is the whole move list, which
//                                      is idempotent by assignment. Kept so the
//                                      file stays a drop-in for SFB, whose
//                                      engine applies deltas.
//     Transport.onData(fn)          -> fn(obj) for each inbound message
//     Transport.onPeerStatus(fn)    -> fn('online'|'offline')
//     Transport.onLinkStatus(fn)    -> fn('connecting'|'open'|'reconnecting'|'closed')
//     Transport.close()
//
// Payloads are AES-GCM encrypted with a key derived from the game code, so the
// public broker relays ciphertext only. The code is the shared secret -- treat
// it like a password, not a room number.
//
// Requires (load before this file):
//   <script src="https://unpkg.com/mqtt@5/dist/mqtt.min.js"></script>
//
// Lab note: public brokers are best-effort and unauthenticated. Fine for a
// private two-player game. Point BROKERS at your own broker for anything real.

(function (global) {
  'use strict';

  // Ordered by preference. Failover walks the list on connect failure.
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];

  const KDF_ITERS = 150000;

  // Wall-clock bound on ONE broker attempt. mqtt.js's own connectTimeout only
  // covers waiting for CONNACK after the socket is up -- it does not bound
  // establishing the socket. A stalled TLS handshake (dead broker, firewall
  // dropping the connection) therefore emits neither 'connect' nor 'error',
  // and without this timer host()/join() hang forever with nothing on screen.
  const DIAL_TIMEOUT_MS = 6000;

  const CFG = {
    ns: 'wfchess-lab',
    salt: 'wfchess-lab/transport/v1',
    clientPrefix: 'wfc',
    log: null                    // optional fn(msg) for lobby/debug output
  };

  // ----------------------------------------------------------------
  // Crypto: game code -> AES-GCM key
  // ----------------------------------------------------------------
  async function deriveKey(code) {
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode(CFG.salt),
        iterations: KDF_ITERS,
        hash: 'SHA-256'
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // Derive a topic slug from the code that is NOT the code itself, so the
  // broker's topic tree never carries the shared secret.
  async function deriveTopicSlug(code) {
    const buf = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode('topic:' + CFG.salt + ':' + code)
    );
    return Array.from(new Uint8Array(buf).slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const b64 = {
    enc: (u8) => btoa(String.fromCharCode(...u8)),
    dec: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
  };

  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
    return JSON.stringify({ iv: b64.enc(iv), ct: b64.enc(new Uint8Array(ct)) });
  }

  async function open(key, raw) {
    const { iv, ct } = JSON.parse(raw);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64.dec(iv) }, key, b64.dec(ct)
    );
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ----------------------------------------------------------------
  // Transport
  // ----------------------------------------------------------------
  const Transport = {
    client: null,
    key: null,
    slug: null,
    role: null,          // 'a' (host) or 'b' (joiner)
    peerRole: null,
    brokerIndex: 0,
    walk: true,          // may _dial fall through to the next broker on failure?

    _dataCb: () => {},
    _peerCb: () => {},
    _reconnectCb: () => {},
    _linkCb: () => {},

    configure(opts) { Object.assign(CFG, opts || {}); return this; },

    _log(msg) {
      if (CFG.log) { try { CFG.log(msg); } catch (_) {} }
      console.info('[transport]', msg);
    },

    onData(fn) { this._dataCb = fn; return this; },
    onPeerStatus(fn) { this._peerCb = fn; return this; },
    // Fires after a RE-connect (not the first one), so the caller can re-push
    // whatever it wants the peer and the broker to have.
    onRelink(fn) { this._reconnectCb = fn; return this; },

    // A backgrounded mobile tab is frozen, not merely idle: its timers do not
    // run, so mqtt.js's own reconnect loop is not ticking either. Coming back
    // to the tab, nothing tries to reconnect until the OS thaws the timers,
    // which can take a while. The shell calls this on visibilitychange to
    // nudge it immediately.
    wake() {
      if (!this.client) return false;
      if (this.client.connected) {
        // Connected, but our retained presence may still be the will payload
        // if the drop was never noticed. Cheap to re-assert.
        this.client.publish(this.presenceOut, '1', { qos: 1, retain: true });
        return true;
      }
      try { this.client.reconnect(); this._log('wake: forcing reconnect'); }
      catch (e) { this._log('wake: ' + e.message); }
      return false;
    },
    onLinkStatus(fn) { this._linkCb = fn; return this; },

    // BROKERS is a list, not a cluster: they share nothing. A retained message
    // published to emqx does not exist on hivemq. So which broker a client
    // lands on is part of a game's identity, and the two sides walking the
    // list independently is how you get "no game on that code" for a code that
    // is perfectly good -- one side timed out on emqx and quietly moved on.
    //
    //   host(code)            walk the list, take the first broker that works
    //   joinAt(code, index)   THIS broker only; the caller does the walking,
    //                         because it is the caller that knows whether the
    //                         game was actually found once connected.
    brokerCount() { return BROKERS.length; },
    brokerName(i) { return BROKERS[i] || '(unknown)'; },

    host(code) { this.walk = true; this.brokerIndex = 0; return this._connect(code, 'a'); },
    joinAt(code, index) { this.walk = false; this.brokerIndex = index; return this._connect(code, 'b'); },
    join(code) { this.walk = true; this.brokerIndex = 0; return this._connect(code, 'b'); },

    async _connect(code, role) {
      this.role = role;
      this.peerRole = role === 'a' ? 'b' : 'a';
      this.key = await deriveKey(code);
      this.slug = await deriveTopicSlug(code);

      const base = `${CFG.ns}/${this.slug}`;
      this.topicOut = `${base}/${this.role}/state`;
      this.topicIn = `${base}/${this.peerRole}/state`;
      this.evtOut = `${base}/${this.role}/evt`;
      this.evtIn = `${base}/${this.peerRole}/evt`;
      this.presenceOut = `${base}/${this.role}/up`;
      this.presenceIn = `${base}/${this.peerRole}/up`;

      // Sequencing for the event channel. sid changes on every page load so a
      // peer that reloads (seq restarting at 1) is not mistaken for a flood of
      // stale duplicates.
      this.sid = Math.random().toString(36).slice(2, 10);
      this.seq = 0;
      this.peerSid = null;
      this.peerSeq = 0;

      return this._dial(base);
    },

    _dial(base) {
      return new Promise((resolve, reject) => {
        const url = BROKERS[this.brokerIndex];
        this._linkCb('connecting');
        this._log(`dialling ${url} (${this.brokerIndex + 1} of ${BROKERS.length})`);
        const t0 = Date.now();

        let settled = false;
        let timer = null;
        const done = () => { settled = true; clearTimeout(timer); };

        // Give up on this broker and walk to the next one. Every failure path
        // routes through here so none of them can leave the promise pending.
        const fail = (why) => {
          if (settled) return;
          done();
          this._log(`${url} failed after ${Date.now() - t0}ms: ${why}`);
          // Mark it dead before ending it. mqtt.js can still fire a callback
          // from an abandoned client -- that is where the alarming-looking
          // "resubscribe failed: Connection closed" came from, logged right
          // next to a genuine failure and reading like a second one.
          try { this.client._abandoned = true; this.client.end(true); } catch (_) {}
          if (this.walk && this.brokerIndex < BROKERS.length - 1) {
            this.brokerIndex++;
            this._dial(base).then(resolve, reject);
          } else {
            this._linkCb('closed');
            reject(new Error(this.walk
              ? 'no broker reachable (tried ' + BROKERS.length + ')'
              : 'could not reach ' + url));
          }
        };

        timer = setTimeout(() => fail('no response in ' + DIAL_TIMEOUT_MS + 'ms'),
                           DIAL_TIMEOUT_MS);

        this.client = global.mqtt.connect(url, {
          clientId: `${CFG.clientPrefix}_${this.slug}_${this.role}_` +
                    Math.random().toString(16).slice(2, 8),
          clean: true,
          // No auto-retry while we are still choosing a broker -- otherwise
          // mqtt.js quietly re-dials a dead host behind our back. Raised once
          // we are connected, below.
          reconnectPeriod: 0,
          connectTimeout: 8000,
          keepalive: 30,
          // Broker announces our death if we drop without saying goodbye.
          will: { topic: this.presenceOut, payload: '0', qos: 1, retain: true }
        });

        this.client.on('connect', () => {
          if (this.client._abandoned) return;
          this._linkCb('open');
          this.client.subscribe(
            [this.topicIn, this.evtIn, this.presenceIn], { qos: 1 },
            (err) => {
              if (this.client._abandoned) return;      // a broker we walked away from
              if (err && !settled) return fail('subscribe: ' + err.message);
              if (err) { this._log('resubscribe failed: ' + err.message); return; }

              // EVERY connect ends here, not just the first. mqtt.js fires
              // 'connect' again after an auto-reconnect, and the work below is
              // exactly what a reconnect needs redone:
              //
              // Our presence is RETAINED, and the broker replaced it with the
              // will payload ('0') the moment we dropped. If we do not
              // re-publish it, we are permanently a ghost: the board works
              // locally, the peer sees "opponent away" forever, and anyone who
              // joins later reads the retained '0' and is told there is no
              // host. That is precisely what a phone does when you switch apps
              // to read the game code out of your email.
              this.client.publish(this.presenceOut, '1', { qos: 1, retain: true });
              this.client.options.reconnectPeriod = 3000;

              if (settled) { this._log('relinked to ' + url); this._reconnectCb(); return; }
              done();
              this._log(`connected to ${url} in ${Date.now() - t0}ms`);
              resolve();
            }
          );
        });

        this.client.on('reconnect', () => this._linkCb('reconnecting'));
        this.client.on('close', () => {
          if (!settled) return fail('socket closed');
          this._linkCb('closed');
        });
        this.client.on('error', (err) => {
          if (!settled) return fail(err.message || String(err));
          console.error('[transport] broker error after connect', err);
        });

        this.client.on('message', async (topic, payload) => {
          if (topic === this.presenceIn) {
            this._peerCb(payload.toString() === '1' ? 'online' : 'offline');
            return;
          }
          let msg;
          try {
            msg = await open(this.key, payload.toString());
          } catch (e) {
            console.error('[transport] decrypt failed -- wrong game code?', e);
            return;
          }

          if (topic === this.topicIn) {
            // Retained snapshot. Idempotent by construction -- apply as-is.
            this._dataCb(msg);
            return;
          }

          if (topic === this.evtIn) {
            // Deltas. QoS 1 is at-least-once, so drop anything we have already
            // applied.
            if (msg.sid !== this.peerSid) {
              this.peerSid = msg.sid;
              this.peerSeq = 0;
            }
            if (msg.seq <= this.peerSeq) {
              console.warn('[transport] dropped duplicate event seq', msg.seq);
              return;
            }
            if (msg.seq > this.peerSeq + 1) {
              console.warn('[transport] event gap: expected',
                this.peerSeq + 1, 'got', msg.seq);
            }
            this.peerSeq = msg.seq;
            this._dataCb(msg.body);
            return;
          }
        });
      });
    },

    // Retained: the broker holds our latest state, so a peer that reconnects
    // mid-game gets it immediately with no resync handshake.
    async send(obj) {
      if (!this.client || !this.client.connected) return false;
      this.client.publish(this.topicOut, await seal(this.key, obj), {
        qos: 1, retain: true
      });
      return true;
    },

    // Deltas. NOT retained -- the broker must never replay these.
    async sendEvent(obj) {
      if (!this.client || !this.client.connected) return false;
      const wrapped = { sid: this.sid, seq: ++this.seq, body: obj };
      this.client.publish(this.evtOut, await seal(this.key, wrapped), {
        qos: 1, retain: false
      });
      return true;
    },

    close() {
      if (!this.client) return;
      this.client.publish(this.presenceOut, '0', { qos: 1, retain: true });
      this.client.end();
      this.client = null;
      this._linkCb('closed');
    }
  };

  global.Transport = Transport;
})(window);