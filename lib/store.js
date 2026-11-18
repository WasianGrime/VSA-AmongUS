// Where the game is saved.
//  - On Vercel: a Redis database from Vercel's Storage tab. Either kind works:
//      "Redis" (Redis Cloud), which sets REDIS_URL, or
//      "Upstash for Redis", which sets KV_REST_API_URL and KV_REST_API_TOKEN.
//  - On a laptop with no Redis set up: in memory, backed up to data.json.
const fs = require('fs');
const path = require('path');
const { freshState, migrate, GameError } = require('./game');

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TCP_URL = process.env.REDIS_URL || process.env.KV_URL;
const PREFIX = process.env.GAME_KEY || 'vsa-amongus';
const STATE_KEY = PREFIX + ':state';
const VERSION_KEY = PREFIX + ':version';
const PROOF_PREFIX = PREFIX + ':proof:';
const PROOF_TTL_SECONDS = 12 * 60 * 60; // photos delete themselves after 12 hours

// ---------- Redis over HTTPS (Upstash REST API) ----------
async function restCommand(command) {
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error('Database error: ' + (data.error || r.status));
  return data.result;
}

// ---------- Redis over a normal connection (Redis Cloud, REDIS_URL) ----------
// One connection per running function, reused between requests.
let tcpClient = null;
function getTcpClient() {
  if (!tcpClient) {
    const { createClient } = require('redis');
    const client = createClient({
      url: TCP_URL,
      socket: { connectTimeout: 5000, reconnectStrategy: tries => (tries > 3 ? new Error('Redis unreachable') : 200) },
    });
    client.on('error', () => {}); // errors surface on the command that failed
    tcpClient = client.connect().then(() => client).catch(err => { tcpClient = null; throw err; });
  }
  return tcpClient;
}
async function tcpCommand(command) {
  try {
    const client = await getTcpClient();
    return await client.sendCommand(command.map(String));
  } catch (err) {
    tcpClient = null;
    throw new Error('Database error: ' + err.message);
  }
}

function redis(...command) {
  return REST_URL && REST_TOKEN ? restCommand(command) : tcpCommand(command);
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
    return { state: migrate(raw ? JSON.parse(raw) : freshState()), version: Number(ver) || 0 };
  },
  async save(state, version) {
    const ok = await redis('EVAL', CAS_SCRIPT, '2', STATE_KEY, VERSION_KEY, String(version), JSON.stringify(state), String(version + 1));
    return Number(ok) === 1;
  },
  async putProof(id, base64) { await redis('SET', PROOF_PREFIX + id, base64, 'EX', String(PROOF_TTL_SECONDS)); },
  async getProof(id) { return redis('GET', PROOF_PREFIX + id); },
  async deleteProofs(ids) { if (ids.length) await redis('DEL', ...ids.map(id => PROOF_PREFIX + id)); },
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
  async load() { memInit(); return { state: migrate(JSON.parse(JSON.stringify(mem.state))), version: mem.version }; },
  async save(state, version) {
    if (version !== mem.version) return false;
    mem = { state, version: version + 1 };
    fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), () => {});
    return true;
  },
  // Photos stay in memory only on a laptop.
  async putProof(id, base64) { memProofs.set(id, base64); },
  async getProof(id) { return memProofs.get(id) || null; },
  async deleteProofs(ids) { ids.forEach(id => memProofs.delete(id)); },
};
const memProofs = new Map();

function pick() {
  if ((REST_URL && REST_TOKEN) || TCP_URL) return redisStore;
  if (process.env.VERCEL) {
    throw new GameError('The game database is not connected yet. In Vercel, open Storage, open your Redis database, connect it to the vsa-among-us project and redeploy.', 503);
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
async function putProof(id, base64) { return pick().putProof(id, base64); }
async function getProof(id) { return pick().getProof(id); }
async function deleteProofs(ids) { if (ids && ids.length) return pick().deleteProofs(ids); }

module.exports = { mutate, read, version, putProof, getProof, deleteProofs };
