// Where the game is saved.
//  - On Vercel: Upstash Redis (add it from the Vercel dashboard: Storage -> Upstash for Redis).
//  - On a laptop with no Redis set up: in memory, backed up to data.json.
const fs = require('fs');
const path = require('path');
const { freshState, GameError } = require('./game');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = process.env.GAME_KEY || 'vsa-amongus';
const STATE_KEY = PREFIX + ':state';
const VERSION_KEY = PREFIX + ':version';

// ---------- Redis (Upstash REST API, no packages needed) ----------
async function redis(...command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error('Database error: ' + (data.error || r.status));
  return data.result;
}

// Save only if nobody else saved since we read. Stops two phones that tap at
// the same moment from wiping out each other's changes.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[2])
if (cur or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 1`;

const redisStore = {
  async version() {
    return Number(await redis('GET', VERSION_KEY)) || 0;
  },
  async load() {
    const [raw, ver] = await redis('MGET', STATE_KEY, VERSION_KEY);
    return { state: raw ? JSON.parse(raw) : freshState(), version: Number(ver) || 0 };
  },
  async save(state, version) {
    const ok = await redis('EVAL', CAS_SCRIPT, '2', STATE_KEY, VERSION_KEY, String(version), JSON.stringify(state), String(version + 1));
    return ok === 1;
  },
};

// ---------- local memory + file ----------
const DATA_FILE = path.join(__dirname, '..', 'data.json');
let mem = null;
function memInit() {
  if (mem) return;
  mem = { state: freshState(), version: 1 };
  try { mem.state = { ...freshState(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch { /* first run */ }
}
const memoryStore = {
  async version() { memInit(); return mem.version; },
  async load() { memInit(); return { state: JSON.parse(JSON.stringify(mem.state)), version: mem.version }; },
  async save(state, version) {
    if (version !== mem.version) return false;
    mem = { state, version: version + 1 };
    fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), () => {});
    return true;
  },
};

function pick() {
  if (REDIS_URL && REDIS_TOKEN) return redisStore;
  if (process.env.VERCEL) {
    throw new GameError('The game database is not set up yet. In Vercel, open Storage, add Upstash for Redis, connect it to this project and redeploy.', 503);
  }
  return memoryStore;
}

// Read the game, change it, save it. Retries if someone else saved first.
async function mutate(fn) {
  const store = pick();
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state, version } = await store.load();
    const result = fn(state);
    if (await store.save(state, version)) return { result, state, version: version + 1 };
    await new Promise(r => setTimeout(r, 20 + Math.random() * 80));
  }
  throw new GameError('Lots of people tapped at once. Try again.', 409);
}

async function read() { return pick().load(); }
async function version() { return pick().version(); }

module.exports = { mutate, read, version };
