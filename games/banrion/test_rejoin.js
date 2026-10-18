// w/test_rejoin.js -- the "phone hosted, then backgrounded" failure.
//
// Drives the real net.js/transport.js against a fake mqtt client so the exact
// broker behaviour can be staged: retained presence, a will payload landing
// when a client drops, and a reconnect firing 'connect' a second time.
const vm = require('vm');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };

// ---- a FLEET: brokers share nothing, which is the whole point of this test --
function makeFleet(urls) {
  const byUrl = {};
  for (const u of urls) { byUrl[u] = makeBroker(); byUrl[u].url = u; byUrl[u].up = true; }
  return {
    urls, byUrl,
    at(url) { const b = byUrl[url]; return b && b.up ? b : null; },
    down(url) { byUrl[url].up = false; },
    up(url) { byUrl[url].up = true; }
  };
}

// ---- a broker: retained store + subscriber fanout, enough for this test ----
function makeBroker() {
  return {
    retained: {}, subs: [],
    publish(topic, payload, opts) {
      if (opts && opts.retain) this.retained[topic] = payload;
      for (const s of this.subs)
        if (s.topics.includes(topic)) s.deliver(topic, payload);
    },
    subscribe(sub) {
      this.subs.push(sub);
      for (const t of sub.topics)
        if (this.retained[t] !== undefined) sub.deliver(t, this.retained[t]);
    },
    // A client vanishing without a DISCONNECT: the broker publishes its will.
    drop(client) {
      this.subs = this.subs.filter(s => s !== client._sub);
      if (client._will) this.publish(client._will.topic, client._will.payload, client._will);
    }
  };
}

// ---- a client that behaves the way mqtt.js does, including reconnect ----
function makeMqtt(fleet) {
  return {
    connect(url, opts) {
      const broker = fleet.at(url);
      if (!broker) {           // unreachable: never fires 'connect'
        const dead = { connected: false, options: opts, on() { return this; },
                       subscribe() {}, publish() {}, end() {}, reconnect() {} };
        return dead;
      }
      const handlers = {};
      const client = {
        connected: false, options: opts, _will: opts.will,
        on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
        _emit(ev, ...a) { (handlers[ev] || []).forEach(f => f(...a)); },
        subscribe(topics, o, cb) {
          this._sub = { topics: [].concat(topics),
                        deliver: (t, p) => this._emit('message', t, Buffer.from(String(p))) };
          broker.subscribe(this._sub);
          cb && cb(null);
        },
        publish(t, p, o) { broker.publish(t, String(p), o); },
        end() { this.connected = false; },
        reconnect() { this._connect(); },
        _connect() { this.connected = true; this._emit('connect'); }
      };
      setTimeout(() => client._connect(), 0);
      return client;
    }
  };
}

function boot(fleet, label) {
  const log = [];
  const ctx = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Buffer,
                TextEncoder, TextDecoder, crypto: require('crypto').webcrypto,
                btoa: b => Buffer.from(b, 'binary').toString('base64'),
                atob: b => Buffer.from(b, 'base64').toString('binary') };
  ctx.window = ctx; ctx.self = ctx; ctx.global = ctx;
  ctx.mqtt = makeMqtt(fleet);
  // shell functions net.js expects
  ctx.status = ''; ctx.revealed = false;
  ctx.setStatus = s => { ctx.status = s; };
  ctx.addLog = m => log.push(m);
  ctx.showToast = () => {};
  ctx.revealBoard = () => { ctx.revealed = true; };
  ctx.onGameChanged = () => {};
  ctx.document = {
    getElementById: id => ({ id, style: {}, value: ctx._joinCode || '',
                             textContent: '', classList: { add(){}, remove(){} },
                             disabled: false }),
    addEventListener() {}
  };
  vm.createContext(ctx);
  for (const f of ['chess', 'transport', 'game', 'net'])
    vm.runInContext(fs.readFileSync('chess (1)/js/' + f + '.js', 'utf8'), ctx);
  ctx.Game.onChange(() => {});
  ctx._log = log; ctx._label = label;
  return ctx;
}

const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const URLS = ['wss://broker.emqx.io:8084/mqtt',
                'wss://broker.hivemq.com:8884/mqtt',
                'wss://test.mosquitto.org:8081/mqtt'];
  const fleet = makeFleet(URLS);
  const broker = fleet.byUrl[URLS[0]];

  console.log('phone hosts, then gets backgrounded');
  const phone = boot(fleet, 'phone');
  await phone.hostGame();
  await tick(20);
  const shown = (phone._log.find(l => l.startsWith('Hosting game: ')) || '').slice(14);
  ok('code carries a broker tag', /^WFC-E[A-Z0-9]{12}$/.test(shown), shown);
  ok('host published a game and its presence',
    Object.keys(broker.retained).some(t => /\/a\/up$/.test(t)) &&
    Object.keys(broker.retained).some(t => /\/a\/state$/.test(t)));

  broker.drop(phone.Transport.client);
  phone.Transport.client.connected = false;
  const upTopic = Object.keys(broker.retained).find(t => /\/a\/up$/.test(t));
  ok('broker advertises the host as offline', broker.retained[upTopic] === '0');

  console.log('\nlaptop joins while the host is asleep');
  const laptop = boot(fleet, 'laptop');
  laptop._joinCode = shown;
  await laptop.joinGame();
  await tick(60);
  ok('laptop found the game anyway', laptop.revealed === true, laptop.status);
  ok('told opponent is away, not that the code is bad',
    laptop.status === 'OPPONENT AWAY', laptop.status);
  ok('adopted the colour the host assigned', laptop.Game.myColor === 'b');

  console.log('\nphone comes back');
  phone.Transport.client._connect();
  await tick(40);
  ok('host re-asserted presence after reconnecting', broker.retained[upTopic] === '1');
  ok('laptop saw the opponent return', laptop.status === 'CONNECTED', laptop.status);
  phone.Game.move('e2', 'e4'); phone.pushGame();
  await tick(40);
  ok('move crossed after the reconnect', laptop.Game.history().join(' ') === 'e4',
    laptop.Game.history());

  // ---- the real-world failure: the two ends land on different brokers ----
  console.log('\nTHE BUG: joiner cannot reach the broker the host is on');
  const fleet2 = makeFleet(URLS);
  const host2 = boot(fleet2, 'host2');
  await host2.hostGame();
  await tick(20);
  const code2 = (host2._log.find(l => l.startsWith('Hosting game: ')) || '').slice(14);
  ok('host2 is on emqx', code2[4] === 'E', code2);

  fleet2.down(URLS[0]);            // emqx unreachable from the joiner's network
  const join2 = boot(fleet2, 'join2');
  join2._joinCode = code2;
  await join2.joinGame();
  await tick(80);
  ok('joiner does NOT claim the code is bad',
    !join2._log.some(l => /Wrong code/.test(l)), join2._log);
  ok('joiner says which broker the game is on',
    join2._log.some(l => /emqx/.test(l) && /code says/i.test(l)), join2._log);

  console.log('\nsame, but emqx comes back');
  fleet2.up(URLS[0]);
  const join3 = boot(fleet2, 'join3');
  join3._joinCode = code2;
  await join3.joinGame();
  await tick(80);
  ok('joiner goes straight to the tagged broker and finds it', join3.revealed === true,
    join3.status);

  // ---- an untagged (old) code still works by walking ----
  console.log('\nlegacy code with no broker tag');
  const fleet3 = makeFleet(URLS);
  fleet3.down(URLS[0]);            // host will land on hivemq
  const host4 = boot(fleet3, 'host4');
  await host4.hostGame();
  await tick(40);
  const code4 = (host4._log.find(l => l.startsWith('Hosting game: ')) || '').slice(14);
  ok('host landed on the second broker and tagged it', code4[4] === 'H', code4);
  const join4 = boot(fleet3, 'join4');
  join4._joinCode = 'WFC-' + code4.slice(5);      // strip the tag: an old-style code
  await join4.joinGame();
  await tick(120);
  ok('untagged code still finds the game by walking', join4.revealed === true,
    [join4.status, join4._log]);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
