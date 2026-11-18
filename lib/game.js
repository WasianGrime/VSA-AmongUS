// Game rules. Every function here works on a plain state object, so the same
// logic runs on Vercel (state kept in Redis) and on a local laptop server.
const crypto = require('crypto');

const DEFAULT_TASKS = [
  { name: 'Memory Match', location: 'Match every pair, then screenshot the finished board' },
  { name: 'Jigsaw', location: 'Finish the puzzle and take a photo or screenshot of it' },
  { name: 'Wordle', location: "Solve today's Wordle and screenshot the result" },
  { name: 'Cup Stack', location: 'Build the cup pyramid and take a photo of it standing' },
  { name: 'Flip Cup', location: 'Flip the cup so it lands upside down, then take a photo' },
  { name: 'Water Bottle Flip', location: 'Land a bottle flip and take a photo of it standing' },
  { name: 'Paper Ball Toss', location: 'Land a paper ball in the bin and take a photo' },
].map((t, i) => ({ id: 'g' + (i + 1), ...t }));

// The task list the app shipped with before. Saved games still using it are
// switched to the new list automatically.
const OLD_DEFAULT_NAMES = ['Fix the wiring', 'Empty the trash', 'Swipe your card', 'Download the data'];

// Task status: todo -> pending (photo sent) -> approved (counts) or rejected (send another).
function migrate(state) {
  const names = (state.taskPool || []).map(t => t.name);
  if (OLD_DEFAULT_NAMES.every(n => names.includes(n))) state.taskPool = DEFAULT_TASKS;
  for (const p of Object.values(state.players || {})) {
    for (const t of p.tasks || []) {
      if (!t.status) t.status = t.done ? 'approved' : 'todo';
    }
  }
  return state;
}

function proofIdsOf(players) {
  const ids = [];
  for (const p of players) for (const t of p.tasks || []) if (t.proofId) ids.push(t.proofId);
  return ids;
}

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

function cleanName(name, max = 24) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, max);
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
  const orphans = proofIdsOf(players);
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
    p.diedAt = null;
    p.tasks = shuffle(state.taskPool).slice(0, per).map(t => ({ ...t, done: false, status: 'todo', proofId: null, submittedAt: null }));
  }
  state.game = { ...emptyGame(), status: 'playing', startedAt: Date.now() };
  return orphans;
}

function backToLobby(state) {
  const orphans = proofIdsOf(Object.values(state.players));
  for (const p of Object.values(state.players)) {
    p.role = null; p.alive = true; p.diedAt = null; p.tasks = [];
  }
  state.game = emptyGame();
  return orphans;
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

function findTask(p, taskId) {
  const t = p.tasks.find(t => t.id === taskId);
  if (!t) throw new GameError('Task not found', 404);
  return t;
}

// A player sends a photo for a task. Returns the old photo's id, if any, to delete.
function submitProof(state, id, taskId, proofId) {
  const p = getPlayer(state, id);
  if (state.game.status !== 'playing' || !p.role) throw new GameError('The game is not running.');
  const t = findTask(p, taskId);
  if (t.status === 'approved') throw new GameError('This task is already approved.');
  const old = t.proofId;
  Object.assign(t, { status: 'pending', proofId, submittedAt: Date.now(), done: false, reviewedAt: null });
  return old;
}

// ---------- keeper actions ----------
function keeperAction(state, body) {
  const pl = body.playerId ? state.players[body.playerId] : null;
  const needPlayer = () => { if (!pl) throw new GameError('Player not found', 404); };
  switch (body.action) {
    case 'start': return startGame(state);
    case 'end': endGame(state, body.winner === 'impostors' ? 'impostors' : 'crew', 'Ended by the Keeper'); break;
    case 'lobby': return backToLobby(state);
    case 'review': {
      needPlayer();
      const t = findTask(pl, body.taskId);
      if (t.status !== 'pending') throw new GameError('That photo was already reviewed.');
      t.status = body.approve ? 'approved' : 'rejected';
      t.done = !!body.approve;
      t.reviewedAt = Date.now();
      checkWin(state);
      break;
    }
    case 'meeting':
      if (state.game.status !== 'playing') throw new GameError('Meetings only happen during a game.');
      if (body.on) {
        const kind = body.kind === 'body' ? 'body' : 'emergency';
        const at = Date.now();
        state.game.meeting = { at, kind, reason: kind === 'body' ? 'Dead body reported' : 'Emergency meeting' };
        state.game.lastMeetingAt = at;
      } else {
        state.game.meeting = null;
      }
      break;
    case 'kick': {
      needPlayer();
      const orphans = proofIdsOf([pl]);
      delete state.players[pl.id];
      checkWin(state);
      return orphans;
    }
    case 'alive':
      needPlayer();
      pl.alive = !!body.alive;
      pl.diedAt = pl.alive ? null : Date.now();
      checkWin(state);
      break;
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
      state.taskPool.push({ id: 't' + crypto.randomBytes(4).toString('hex'), name, location: cleanName(body.location, 80) });
      break;
    }
    case 'removeTask': state.taskPool = state.taskPool.filter(t => t.id !== body.taskId); break;
    case 'resetTasks': state.taskPool = DEFAULT_TASKS; break;
    case 'clearPlayers': {
      const orphans = proofIdsOf(Object.values(state.players));
      state.players = {};
      backToLobby(state);
      return orphans;
    }
    default: throw new GameError('Unknown action');
  }
  return [];
}

// ---------- what each screen is allowed to see ----------
function playerView(state, id) {
  const me = state.players[id];
  if (!me) return { gone: true };
  const all = Object.values(state.players).sort((a, b) => a.joinedAt - b.joinedAt);
  const { lastMeetingAt, ...game } = state.game;
  const view = {
    me: { id: me.id, name: me.name, role: me.role, alive: me.alive, tasks: me.tasks },
    game: { ...game, progress: crewProgress(state) },
    roster: all.map(p => ({
      name: p.name || 'Player ' + p.id,
      isMe: p.id === id,
      // Other players only learn someone is dead once a meeting is called,
      // so marking a death doesn't give away who the impostor just got.
      alive: state.game.status !== 'playing' || p.alive ||
        (p.id !== id && !(p.diedAt <= (state.game.lastMeetingAt || 0))),
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

module.exports = { freshState, migrate, GameError, join, getPlayer, submitProof, keeperAction, playerView, keeperView, cleanName };
