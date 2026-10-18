// banrion/js/net.js
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
// Networking layer. Wraps Transport (js/transport.js) and drives the lobby.
// Structure follows the SFB net.js -- same two-stage lobby, same
// presence-gated reveal -- with the delta machinery removed. Chess publishes
// one retained snapshot (the move list) and nothing else.
//
// Public surface:
//   hostGame()    -- onclick, #btn-host
//   joinGame()    -- onclick, #btn-join
//   goLocal()     -- onclick, #btn-local  (hot-seat, no network)
//   pushGame()    -- called by game.js consumers after any local change
//
// Depends on globals: Game, Transport, setStatus, addLog, showToast,
// onGameChanged, revealBoard.

// The game code is also the shared secret for payload encryption in
// transport.js. 12 chars over a 32-symbol alphabet is 60 bits -- readable over
// the phone, and not worth brute-forcing for a two-player game.
const GAME_CODE_LEN = 12;
const CODE_PREFIX = 'WFC-';

// How long a joiner waits, ON ONE BROKER, for the retained snapshot to show
// up. Retained messages arrive on subscribe, so this only has to cover the
// round trip -- it is per broker now, not per join.
const BROKER_WAIT_MS = 4000;

// The brokers do not share state, so the code has to say which one the game
// lives on. One character in front of the random body, from the same read-
// aloud alphabet. The BODY alone still derives the key and the topic slug, so
// the tag is routing metadata and nothing else -- and a 12-character code from
// before this existed still works, it just has to try every broker.
const BROKER_TAG = 'EHM';        // index -> character, in BROKERS order

let gameId = null;
let joinTimer = null;
let joinWaiter = null;      // set while a join is waiting on one broker
let peerPresent = false;
// Have we ever seen evidence this game exists -- a retained snapshot on the
// code's topic? That is a different question from "is the opponent awake
// right now", and joining should turn on the first, not the second.
let gameSeen = false;

// Host picks the colours; the joiner adopts whatever the host published rather
// than assuming, so a swap or a randomised draw needs no handshake.
let hostPlaysWhite = true;

// Split a typed code into the broker hint and the part that derives the key.
function parseCode(raw) {
  const body = raw.startsWith(CODE_PREFIX) ? raw.slice(CODE_PREFIX.length) : raw;
  if (body.length === GAME_CODE_LEN + 1) {
    const i = BROKER_TAG.indexOf(body[0]);
    if (i >= 0) return { tag: i, body: body.slice(1) };
  }
  return { tag: -1, body };          // untagged, or a tag we do not know
}

// Preferred broker first, then the rest as a fallback -- a host can move.
function brokerOrder(preferred) {
  const all = [];
  for (let i = 0; i < Transport.brokerCount(); i++) all.push(i);
  if (preferred < 0) return all;
  return [preferred].concat(all.filter(i => i !== preferred));
}

function generateGameId() {
  // Ambiguous glyphs (0/O, 1/I/L) omitted -- these get read aloud.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(GAME_CODE_LEN);
  crypto.getRandomValues(buf);
  let id = '';
  for (let i = 0; i < GAME_CODE_LEN; i++) id += chars[buf[i] % chars.length];
  return id;
}

// Element lookup that complains instead of going quiet. A silent `if (el)`
// guard here is how a stale id from the SFB markup ("game-id-display" for what
// this page calls "code") got as far as a live host: the game code was
// generated and published, and the panel just never showed it.
function el(id) {
  const node = document.getElementById(id);
  if (!node) {
    console.error('[net] missing element #' + id);
    if (typeof addLog === 'function') addLog('UI element #' + id + ' is missing');
  }
  return node || { style: {}, classList: { add() {}, remove() {} } };
}

function lobbyButtons(enabled) {
  for (const id of ['btn-host', 'btn-join', 'btn-local']) el(id).disabled = !enabled;
}

function wireTransport() {
  Transport
    .configure({ ns: 'wfchess-lab', salt: 'wfchess-lab/transport/v1',
                 clientPrefix: 'wfc', log: addLog })
    .onData(handleMessage)
    .onPeerStatus((s) => (s === 'online' ? onPeerArrived() : onPeerLost()))
    // A reconnect leaves the peer holding whatever we published before we
    // dropped. Re-push so their retained copy is current, and say so.
    .onRelink(() => { addLog('Link re-established.'); pushGame(); })
    .onLinkStatus((s) => {
      // Only report link trouble once we are past the lobby -- otherwise the
      // initial 'connecting' would stomp on the lobby's own status text.
      if (!peerPresent) return;
      if (s === 'reconnecting') setStatus('RELINKING...');
      if (s === 'closed') setStatus('LINK DOWN');
      if (s === 'open') setStatus('CONNECTED');
    });
}

// ----------------------------------------------------------------
// local hot-seat
// ----------------------------------------------------------------
function goLocal() {
  Game.mode = 'local';
  Game.reset();
  revealBoard();
  setStatus('LOCAL GAME');
  addLog('Hot-seat game - both sides on this device.');
}

// ----------------------------------------------------------------
// lobby
// ----------------------------------------------------------------
async function hostGame() {
  const body = generateGameId();
  gameId = CODE_PREFIX + body;      // provisional; the tag is added on connect
  Game.mode = 'online';
  Game.myColor = hostPlaysWhite ? 'w' : 'b';
  Game.reset();
  peerPresent = false;

  lobbyButtons(false);
  setStatus('OPENING CHANNEL...');
  Transport.brokerIndex = 0;      // a retry starts from the top of the list
  wireTransport();

  try {
    await Transport.host(gameId);
  } catch (err) {
    console.error('[net] host failed', err);
    addLog('Could not reach any broker: ' + err.message);
    showToast('No broker reachable - check your connection');
    setStatus('NO BROKER');
    lobbyButtons(true);
    return;
  }

  // Subscribed. Only now do we know which broker we landed on, so only now
  // can the code carry it. The tag is display-only: the topic and the key came
  // from the body, which has not changed.
  const tag = BROKER_TAG[Transport.brokerIndex] || '';
  const shown = CODE_PREFIX + tag + body;

  // Subscribed. NOT connected to a peer yet -- show the code and hold here.
  el('host-id-area').style.display = 'block';
  el('code').textContent = shown;
  setStatus('WAITING FOR OPPONENT...');
  addLog('Hosting game: ' + shown);
  addLog('Send that code to your opponent.');

  // Publish immediately, retained: an opponent who joins later gets the colour
  // assignment and the (empty) move list the moment they subscribe.
  pushGame();
}

async function joinGame() {
  const raw = (el('join-code').value || '').trim().toUpperCase();
  if (!raw) { showToast('Enter a game code'); return; }

  const { tag, body } = parseCode(raw);
  gameId = CODE_PREFIX + body;          // the body is what derives slug and key

  Game.mode = 'online';
  Game.myColor = 'b';        // provisional; the host's snapshot is authoritative
  Game.reset();
  peerPresent = false;
  gameSeen = false;

  lobbyButtons(false);
  wireTransport();

  const order = brokerOrder(tag);
  let reached = 0;

  // Walk the brokers looking for the GAME, not merely for a connection. A
  // joiner that connects successfully to a broker the host never used has
  // found nothing, and must keep going -- the old code stopped at the first
  // working socket and reported a bad code.
  for (const idx of order) {
    setStatus('CONNECTING...');
    try {
      await Transport.joinAt(gameId, idx);
    } catch (err) {
      addLog('Could not reach ' + Transport.brokerName(idx) + ' - trying the next.');
      continue;
    }
    reached++;
    setStatus('LOCATING GAME...');
    addLog('Subscribed - looking for the game on ' + Transport.brokerName(idx));

    const found = await waitForGame(BROKER_WAIT_MS);
    if (found) return;                  // onGameSeen/onPeerArrived did the reveal

    addLog('Nothing on that broker.');
    Transport.close();
  }

  // Exhausted. Distinguish "your code is wrong" from "the broker your opponent
  // is on is unreachable from here", because those need different actions.
  if (reached === 0) {
    showToast('No broker reachable - check your connection');
    setStatus('NO BROKER');
    addLog('Could not reach any broker.');
  } else if (tag >= 0) {
    showToast('That game is on a broker I could not reach');
    setStatus('NO GAME');
    addLog('The code says the game is on ' + Transport.brokerName(tag) +
           '. Nothing was found there or anywhere else.');
  } else {
    showToast('No game on that code - check it and retry');
    setStatus('NO GAME');
    addLog('Nothing retained on that code, on any broker.');
  }
  lobbyButtons(true);
}

// Resolves true as soon as the retained snapshot or the peer shows up.
function waitForGame(ms) {
  return new Promise(resolve => {
    if (gameSeen || peerPresent) return resolve(true);
    let settled = false;
    const finish = v => { if (settled) return; settled = true;
                          clearTimeout(joinTimer); joinWaiter = null; resolve(v); };
    joinWaiter = () => finish(true);
    joinTimer = setTimeout(() => finish(gameSeen || peerPresent), ms);
  });
}

// ----------------------------------------------------------------
// peer presence
// ----------------------------------------------------------------
function onPeerArrived() {
  gameSeen = true;
  clearTimeout(joinTimer);
  if (joinWaiter) joinWaiter();
  // Presence is a retained message, so this can fire more than once
  // (reconnect, broker replay). Only do the reveal on the first edge.
  if (peerPresent) {
    setStatus('CONNECTED');
    addLog('Opponent back online');
    pushGame();          // re-push in case their retained copy is stale
    return;
  }

  peerPresent = true;
  clearTimeout(joinTimer);

  setStatus('CONNECTED');
  revealBoard();
  addLog('Opponent connected.');
  showToast('Channel open');
  pushGame();
}

function onPeerLost() {
  // Presence is retained, so a single drop is announced twice: once live and
  // once more when we re-subscribe. Log the edge, not each delivery.
  const wasPresent = peerPresent;
  peerPresent = false;
  if (!wasPresent && gameSeen) return;
  // Arriving to a retained '0' is the normal case when the host is asleep, so
  // this fires before any peer was ever present. Say something useful in both
  // situations rather than returning early and leaving the lobby silent.
  if (gameSeen) setStatus('OPPONENT AWAY');
  addLog('Opponent is offline - the move list is retained, they can rejoin.');
}

// The retained snapshot is proof the game exists. Sit down at the board even
// if the other side is currently away; their moves will arrive when they
// return, and ours are retained for them in the meantime.
function onGameSeen() {
  if (gameSeen) return;
  gameSeen = true;
  clearTimeout(joinTimer);
  if (joinWaiter) joinWaiter();
  revealBoard();
  if (!peerPresent) {
    setStatus('OPPONENT AWAY');
    addLog('Joined - opponent is not online yet. You can move when it is your turn.');
  }
}

// ----------------------------------------------------------------
// messages
// ----------------------------------------------------------------
function handleMessage(data) {
  if (!data || data.type !== 'game') {
    console.warn('[net] unknown message', data && data.type);
    return;
  }

  // Colour assignment travels with the host's snapshot. Only the joiner adopts
  // it -- the host is the one asserting it.
  if (Transport.role === 'b' && (data.white === 'a' || data.white === 'b')) {
    const mine = data.white === 'b' ? 'w' : 'b';
    if (Game.myColor !== mine) {
      Game.myColor = mine;
      addLog('Playing ' + (mine === 'w' ? 'White' : 'Black') + '.');
    }
  }

  onGameSeen();

  const r = Game.adopt(data);
  if (!r.ok) {
    // Never silently overwrite a good board with a bad snapshot.
    console.warn('[net] rejected snapshot:', r.reason);
    if (r.reason === 'divergent') {
      addLog('Move lists diverged - boards are out of step.');
      showToast('Desync: opponent sent a different game');
    } else if (r.reason.startsWith('illegal-move')) {
      addLog('Rejected an illegal move from the opponent: ' + r.reason);
      showToast('Rejected an illegal move');
    }
    return;
  }
  if (r.applied > 0) onGameChanged();
}

// Fire-and-forget. Retained on the broker, so this doubles as the resume
// snapshot -- there is no separate resync path.
function pushGame() {
  if (Game.mode !== 'online' || !Transport.client) return;
  const snap = Game.snapshot();
  if (Transport.role === 'a') snap.white = hostPlaysWhite ? 'a' : 'b';
  Transport.send(snap).catch((err) => console.error('[net] send failed', err));
}