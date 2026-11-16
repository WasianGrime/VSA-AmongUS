// Game rules. Every function here works on a plain state object, so the same
// logic runs on Vercel (state kept in Redis) and on a local laptop server.
const crypto = require('crypto');

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

function emptyGame() {
  return { status: 'lobby', startedAt: null, endedAt: null, winner: null, reason: null, meeting: null };
}

function freshState() {
  return {
    players: {},
    taskPool: DEFAULT_TASKS,
    settings: { impostors: 1, tasksPerPlayer: 4 },
    game: emptyGame(),
  };
}

class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function crewProgress(state) {
  let done = 0, total = 0;
  for (const p of Object.values(state.players)) {
    if (p.role !== 'crewmate') continue;
    for (const t of p.tasks) { total++; if (t.done) done++; }
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

function endGame(state, winner, reason) {
  state.game.status = 'ended';
  state.game.winner = winner;
  state.game.reason = reason;
  state.game.endedAt = Date.now();
  state.game.meeting = null;
}

function checkWin(state) {
  if (state.game.status !== 'playing') return;
  const players = Object.values(state.players).filter(p => p.role);
  const aliveImp = players.filter(p => p.role === 'impostor' && p.alive).length;
  const aliveCrew = players.filter(p => p.role === 'crewmate' && p.alive).length;
  const prog = crewProgress(state);
  if (prog.total > 0 && prog.done === prog.total) return endGame(state, 'crew', 'All tasks completed');
  if (aliveImp === 0) return endGame(state, 'crew', 'Every impostor was caught');
  if (aliveImp >= aliveCrew) return endGame(state, 'impostors', 'Impostors matched the crew');
}

function startGame(state) {
  const players = Object.values(state.players);
  if (players.length < 2) throw new GameError('You need at least 2 players to start.');
  if (!state.taskPool.length) throw new GameError('Add at least one task first.');
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
  state.game = { ...emptyGame(), status: 'playing', startedAt: Date.now() };
}

function backToLobby(state) {
  for (const p of Object.values(state.players)) {
    p.role = null; p.alive = true; p.tasks = [];
  }
  state.game = emptyGame();
}

// ---------- player actions ----------
function join(state, name) {
  let id;
  do { id = String(crypto.randomInt(1000, 10000)); } while (state.players[id]);
  // A player who joins mid-game watches until the next round.
  state.players[id] = { id, name: cleanName(name), joinedAt: Date.now(), role: null, alive: true, tasks: [], forceImpostor: false };
  return id;
}

function getPlayer(state, id) {
  const p = state.players[String(id || '')];
  if (!p) throw new GameError('No player has that ID. Check the number or join as a new player.', 404);
  return p;
}

function setTask(state, id, taskId, done) {
  const p = getPlayer(state, id);
  if (state.game.status !== 'playing') throw new GameError('The game is not running.');
  const t = p.tasks.find(t => t.id === taskId);
  if (!t) throw new GameError('Task not found', 404);
  t.done = !!done;
  checkWin(state);
}

// ---------- keeper actions ----------
function keeperAction(state, body) {
  const pl = body.playerId ? state.players[body.playerId] : null;
  const needPlayer = () => { if (!pl) throw new GameError('Player not found', 404); };
  switch (body.action) {
    case 'start': startGame(state); break;
    case 'end': endGame(state, body.winner === 'impostors' ? 'impostors' : 'crew', 'Ended by the Keeper'); break;
    case 'lobby': backToLobby(state); break;
    case 'meeting':
      if (state.game.status !== 'playing') throw new GameError('Meetings only happen during a game.');
      state.game.meeting = body.on ? { at: Date.now(), reason: cleanName(body.reason) || 'Emergency meeting' } : null;
      break;
    case 'kick': needPlayer(); delete state.players[pl.id]; checkWin(state); break;
    case 'alive': needPlayer(); pl.alive = !!body.alive; checkWin(state); break;
    case 'forceImpostor': needPlayer(); pl.forceImpostor = !!body.value; break;
    case 'rename': needPlayer(); pl.name = cleanName(body.name); break;
    case 'settings': {
      const imp = Math.round(Number(body.impostors));
      const per = Math.round(Number(body.tasksPerPlayer));
      if (imp >= 1 && imp <= 10) state.settings.impostors = imp;
      if (per >= 1 && per <= 20) state.settings.tasksPerPlayer = per;
      break;
    }
    case 'addTask': {
      const name = cleanName(body.name);
      if (!name) throw new GameError('Give the task a name.');
      state.taskPool.push({ id: 't' + crypto.randomBytes(4).toString('hex'), name, location: cleanName(body.location) });
      break;
    }
    case 'removeTask': state.taskPool = state.taskPool.filter(t => t.id !== body.taskId); break;
    case 'resetTasks': state.taskPool = DEFAULT_TASKS; break;
    case 'clearPlayers': state.players = {}; backToLobby(state); break;
    default: throw new GameError('Unknown action');
  }
}

// ---------- what each screen is allowed to see ----------
function playerView(state, id) {
  const me = state.players[id];
  if (!me) return { gone: true };
  const all = Object.values(state.players).sort((a, b) => a.joinedAt - b.joinedAt);
  const view = {
    me: { id: me.id, name: me.name, role: me.role, alive: me.alive, tasks: me.tasks },
    game: { ...state.game, progress: crewProgress(state) },
    roster: all.map(p => ({
      name: p.name || 'Player ' + p.id,
      isMe: p.id === id,
      alive: state.game.status === 'playing' ? p.alive : true,
      // roles are only revealed when the game is over
      role: state.game.status === 'ended' ? p.role : undefined,
    })),
  };
  if (me.role === 'impostor' && state.game.status === 'playing') {
    view.teammates = all.filter(p => p.role === 'impostor' && p.id !== id).map(p => p.name || 'Player ' + p.id);
  }
  return view;
}

function keeperView(state) {
  return {
    players: Object.values(state.players).sort((a, b) => a.joinedAt - b.joinedAt),
    taskPool: state.taskPool,
    settings: state.settings,
    game: { ...state.game, progress: crewProgress(state) },
  };
}

module.exports = { freshState, GameError, join, getPlayer, setTask, keeperAction, playerView, keeperView, cleanName };
