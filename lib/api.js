// All API routes. Each file in /api just hands its request to this router,
// and the local laptop server uses it too.
const crypto = require('crypto');
const game = require('./game');
const store = require('./store');

const PASSCODE = process.env.KEEPER_PASSCODE || '250247';
const SECRET = process.env.KEEPER_SECRET || 'vsa-amongus:' + PASSCODE;
// The Keeper's login token. It stays valid until the passcode changes,
// so it keeps working however many servers Vercel spins up.
const KEEPER_TOKEN = crypto.createHmac('sha256', SECRET).update('keeper').digest('hex');

function sameText(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel parses JSON already
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function keeperExtras() {
  try { return JSON.parse(process.env.LOCAL_KEEPER_EXTRAS || '{}'); } catch { return {}; }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname.replace(/\/+$/, '');
  const isKeeper = sameText(req.headers['x-keeper-token'], KEEPER_TOKEN);

  try {
    if (req.method === 'GET') {
      if (route === '/api/state') {
        const id = url.searchParams.get('id') || '';
        const have = Number(url.searchParams.get('v'));
        const v = await store.version();
        if (have && have === v) return send(res, 200, { same: true, v });
        const { state, version } = await store.read();
        return send(res, 200, { v: version, view: game.playerView(state, id) });
      }
      if (route === '/api/keeper/state') {
        if (!isKeeper) return send(res, 401, { error: 'Keeper login required' });
        const have = Number(url.searchParams.get('v'));
        const v = await store.version();
        if (have && have === v) return send(res, 200, { same: true, v });
        const { state, version } = await store.read();
        return send(res, 200, { v: version, view: { ...game.keeperView(state), ...keeperExtras() } });
      }
      return send(res, 404, { error: 'Unknown endpoint' });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const body = await readBody(req);

    switch (route) {
      case '/api/join': {
        const { result: id, state, version } = await store.mutate(s => game.join(s, body.name));
        return send(res, 200, { id, v: version, view: game.playerView(state, id) });
      }
      case '/api/rejoin': {
        const id = String(body.id || '').trim();
        const { state, version } = await store.read();
        game.getPlayer(state, id);
        return send(res, 200, { id, v: version, view: game.playerView(state, id) });
      }
      case '/api/name': {
        const { state, version } = await store.mutate(s => { game.getPlayer(s, body.id).name = game.cleanName(body.name); });
        return send(res, 200, { v: version, view: game.playerView(state, body.id) });
      }
      case '/api/task': {
        const { state, version } = await store.mutate(s => game.setTask(s, body.id, body.taskId, body.done));
        return send(res, 200, { v: version, view: game.playerView(state, body.id) });
      }
      case '/api/keeper/login': {
        if (!sameText(body.passcode, PASSCODE)) return send(res, 401, { error: 'Wrong passcode' });
        return send(res, 200, { token: KEEPER_TOKEN });
      }
      case '/api/keeper/action': {
        if (!isKeeper) return send(res, 401, { error: 'Keeper login required' });
        const { state, version } = await store.mutate(s => game.keeperAction(s, body));
        return send(res, 200, { v: version, view: { ...game.keeperView(state), ...keeperExtras() } });
      }
      default:
        return send(res, 404, { error: 'Unknown endpoint' });
    }
  } catch (e) {
    const status = e instanceof game.GameError ? e.status : 500;
    if (status === 500) console.error(e);
    return send(res, status, { error: status === 500 ? 'Something went wrong on the server. Try again.' : e.message });
  }
}

module.exports = handle;
