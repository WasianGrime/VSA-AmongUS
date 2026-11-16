// VSA Among Us — in-person game tracker.
// Zero dependencies: run with `node server.js` and open the printed address.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const KEEPER_PASSCODE = process.env.KEEPER_PASSCODE || '250247';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_TASKS = [
  { name: 'Fix the wiring', location: 'Kitchen' },
  { name: 'Empty the trash', location: 'Garage' },
  { name: 'Swipe your card', location: 'Front door' },
  { name: 'Download the data', location: 'Office' },
  { name: 'Align the engine', location: 'Laundry room' },
  { name: 'Clear the asteroids', location: 'Living room' },
  { name: 'Fuel the engines', location: 'Back yard' },
  { name: 'Submit a scan', location: 'Bathroom' },
  { name: 'Clean the vent', location: 'Hallway' },
  { name: 'Calibrate the distributor', location: 'Dining room' },
  { name: 'Water the plants', location: 'Porch' },
  { name: 'Sort the samples', location: 'Bedroom' },
].map((t, i) => ({ id: 't' + (i + 1), ...t }));

function freshState() {
  return {
    players: {},
    taskPool: DEFAULT_TASKS,
    settings: { impostors: 1, tasksPerPlayer: 4 },
    game: { status: 'lobby', startedAt: null, endedAt: null, winner: null, reason: null, meeting: null },
  };
}

let state = freshState();
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  state = { ...freshState(), ...saved };
} catch { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), () => {});
  }, 300);
}

const keeperTokens = new Set();

// ---------- helpers ----------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newPlayerId() {
  for (;;) {
    const id = String(1000 + Math.floor(Math.random() * 9000));
    if (!state.players[id]) return id;
  }
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function crewProgress() {
  let done = 0, total = 0;
  for (const p of Object.values(state.players)) {
    if (p.role !== 'crewmate') continue;
    for (const t of p.tasks) { total++; if (t.done) done++; }
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

function endGame(winner, reason) {
  state.game.status = 'ended';
  state.game.winner = winner;
  state.game.reason = reason;
  state.game.endedAt = Date.now();
  state.game.meeting = null;
}

function checkWin() {
  if (state.game.status !== 'playing') return;
  const players = Object.values(state.players).filter(p => p.role);
  const aliveImp = players.filter(p => p.role === 'impostor' && p.alive).length;
  const aliveCrew = players.filter(p => p.role === 'crewmate' && p.alive).length;
  const prog = crewProgress();
  if (prog.total > 0 && prog.done === prog.total) return endGame('crew', 'All tasks completed');
  if (aliveImp === 0) return endGame('crew', 'Every impostor was caught');
  if (aliveImp >= aliveCrew) return endGame('impostors', 'Impostors matched the crew');
}

function startGame() {
  const players = Object.values(state.players);
  if (players.length < 2) throw new Error('You need at least 2 players to start.');
  if (!state.taskPool.length) throw new Error('Add at least one task first.');
  const impCount = Math.max(1, Math.min(state.settings.impostors, players.length - 1));

  const forced = shuffle(players.filter(p => p.forceImpostor));
  const others = shuffle(players.filter(p => !p.forceImpostor));
  const impostorIds = new Set([...forced, ...others].slice(0, impCount).map(p => p.id));

  const per = Math.max(1, Math.min(state.settings.tasksPerPlayer, state.taskPool.length));
  for (const p of players) {
    p.role = impostorIds.has(p.id) ? 'impostor' : 'crewmate';
    p.alive = true;
    p.tasks = shuffle(state.taskPool).slice(0, per).map(t => ({ ...t, done: false }));
  }
  state.game = { status: 'playing', startedAt: Date.now(), endedAt: null, winner: null, reason: null, meeting: null };
}

function backToLobby() {
  for (const p of Object.values(state.players)) {
    p.role = null; p.alive = true; p.tasks = [];
  }
  state.game = { status: 'lobby', startedAt: null, endedAt: null, winner: null, reason: null, meeting: null };
}

// ---------- views ----------
function publicGame() {
  return { ...state.game, progress: crewProgress() };
}

function playerView(id) {
  const me = state.players[id];
  if (!me) return { gone: true };
  const all = Object.values(state.players);
  const roster = all
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(p => ({
      name: p.name || 'Player ' + p.id,
      isMe: p.id === id,
      alive: state.game.status === 'playing' ? p.alive : true,
      // roles are only revealed when the game is over
      role: state.game.status === 'ended' ? p.role : undefined,
    }));
  const view = {
    me: { id: me.id, name: me.name, role: me.role, alive: me.alive, tasks: me.tasks },
    game: publicGame(),
    roster,
  };
  if (me.role === 'impostor' && state.game.status === 'playing') {
    view.teammates = all.filter(p => p.role === 'impostor' && p.id !== id).map(p => p.name || 'Player ' + p.id);
  }
  return view;
}

function keeperView() {
  return {
    players: Object.values(state.players).sort((a, b) => a.joinedAt - b.joinedAt),
    taskPool: state.taskPool,
    settings: state.settings,
    game: publicGame(),
    joinUrls: lanUrls(),
  };
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set(); // { res, kind: 'player'|'keeper', id }

function send(client) {
  const data = client.kind === 'keeper' ? keeperView() : playerView(client.id);
  client.res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast() {
  save();
  for (const c of clients) send(c);
}

setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 20000);

// ---------- http ----------
function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/keeper') pathname = '/keeper.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function isKeeper(req, url) {
  const token = req.headers['x-keeper-token'] || url.searchParams.get('token');
  return token && keeperTokens.has(token);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // --- live streams ---
    if (p === '/api/events' || p === '/api/keeper/events') {
      const kind = p === '/api/events' ? 'player' : 'keeper';
      if (kind === 'keeper' && !isKeeper(req, url)) return json(res, 401, { error: 'Keeper login required' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const client = { res, kind, id: url.searchParams.get('id') };
      clients.add(client);
      send(client);
      req.on('close', () => clients.delete(client));
      return;
    }

    if (req.method === 'POST' && p.startsWith('/api/')) {
      const body = await readBody(req);

      // --- player actions ---
      if (p === '/api/join') {
        const id = newPlayerId();
        state.players[id] = { id, name: cleanName(body.name), joinedAt: Date.now(), role: null, alive: true, tasks: [], forceImpostor: false };
        // A player who joins mid-game watches until the next round.
        broadcast();
        return json(res, 200, { id });
      }
      if (p === '/api/rejoin') {
        const id = String(body.id || '').trim();
        if (!state.players[id]) return json(res, 404, { error: 'No player has that ID. Check the number or join as a new player.' });
        return json(res, 200, { id });
      }
      if (p === '/api/name') {
        const pl = state.players[body.id];
        if (!pl) return json(res, 404, { error: 'Player not found' });
        pl.name = cleanName(body.name);
        broadcast();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/task') {
        const pl = state.players[body.id];
        if (!pl) return json(res, 404, { error: 'Player not found' });
        if (state.game.status !== 'playing') return json(res, 400, { error: 'The game is not running.' });
        const t = pl.tasks.find(t => t.id === body.taskId);
        if (!t) return json(res, 404, { error: 'Task not found' });
        t.done = !!body.done;
        checkWin();
        broadcast();
        return json(res, 200, { ok: true });
      }

      // --- keeper ---
      if (p === '/api/keeper/login') {
        if (String(body.passcode) !== KEEPER_PASSCODE) return json(res, 401, { error: 'Wrong passcode' });
        const token = crypto.randomBytes(24).toString('hex');
        keeperTokens.add(token);
        return json(res, 200, { token });
      }
      if (p === '/api/keeper/action') {
        if (!isKeeper(req, url)) return json(res, 401, { error: 'Keeper login required' });
        const pl = body.playerId ? state.players[body.playerId] : null;
        switch (body.action) {
          case 'start': startGame(); break;
          case 'end': endGame(body.winner === 'impostors' ? 'impostors' : 'crew', 'Ended by the Keeper'); break;
          case 'lobby': backToLobby(); break;
          case 'meeting':
            if (state.game.status !== 'playing') throw new Error('Meetings only happen during a game.');
            state.game.meeting = body.on ? { at: Date.now(), reason: cleanName(body.reason) || 'Emergency meeting' } : null;
            break;
          case 'kick':
            if (!pl) throw new Error('Player not found');
            delete state.players[pl.id];
            checkWin();
            break;
          case 'alive':
            if (!pl) throw new Error('Player not found');
            pl.alive = !!body.alive;
            checkWin();
            break;
          case 'forceImpostor':
            if (!pl) throw new Error('Player not found');
            pl.forceImpostor = !!body.value;
            break;
          case 'rename':
            if (!pl) throw new Error('Player not found');
            pl.name = cleanName(body.name);
            break;
          case 'settings': {
            const imp = Math.round(Number(body.impostors));
            const per = Math.round(Number(body.tasksPerPlayer));
            if (imp >= 1 && imp <= 10) state.settings.impostors = imp;
            if (per >= 1 && per <= 20) state.settings.tasksPerPlayer = per;
            break;
          }
          case 'addTask': {
            const name = cleanName(body.name);
            if (!name) throw new Error('Give the task a name.');
            state.taskPool.push({ id: 't' + crypto.randomBytes(4).toString('hex'), name, location: cleanName(body.location) });
            break;
          }
          case 'removeTask':
            state.taskPool = state.taskPool.filter(t => t.id !== body.taskId);
            break;
          case 'resetTasks':
            state.taskPool = DEFAULT_TASKS;
            break;
          case 'clearPlayers':
            state.players = {};
            backToLobby();
            break;
          default:
            throw new Error('Unknown action');
        }
        broadcast();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Unknown endpoint' });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    json(res, 400, { error: e.message || 'Something went wrong' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  VSA Among Us tracker is running.\n`);
  console.log(`  On this computer:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Players on Wi-Fi:   ${u}`);
  console.log(`  Keeper dashboard:   add /keeper to the address\n`);
});
