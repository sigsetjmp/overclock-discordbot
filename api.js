require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.API_TOKEN || '';
const DB_FILE = path.join(__dirname, 'db.json');
const MAX_BODY = 1024 * 1024;
const RATE_MAX = 120;
const RATE_WINDOW_MS = 10000;

function emptyDB() {
  return {
    bans: [],
    announcements: { nextId: 1, rows: [] },
    commands: { nextId: 1, rows: [] },
    snapshot: null,
  };
}

function loadDB() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const base = emptyDB();
    return {
      bans: Array.isArray(parsed.bans) ? parsed.bans : base.bans,
      announcements: parsed.announcements && Array.isArray(parsed.announcements.rows) ? parsed.announcements : base.announcements,
      commands: parsed.commands && Array.isArray(parsed.commands.rows) ? parsed.commands : base.commands,
      snapshot: typeof parsed.snapshot === 'string' ? parsed.snapshot : null,
    };
  } catch {
    const base = emptyDB();
    saveDB(base);
    return base;
  }
}

function saveDB(d) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const db = loadDB();

function save() { saveDB(db); }

function authed(req) {
  if (!TOKEN) return false;
  let given = req.headers['x-api-token'];
  if (!given) {
    const u = new URL(req.url, 'http://x');
    given = u.searchParams.get('token') || '';
  }
  given = String(given);
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const arr = (hits.get(ip) || []).filter((t) => t > cutoff);
  if (arr.length >= RATE_MAX) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function latest(rowKey, cols) {
  const rows = db[rowKey].rows;
  const last = rows[rows.length - 1];
  if (!last) return Object.fromEntries(cols.map((c) => [c, c === 'id' ? 0 : '']));
  const out = {};
  for (const c of cols) out[c] = last[c];
  return out;
}

function parseSnapshot(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function broadcastSnapshot() {
  const payload = parseSnapshot(db.snapshot) ?? db.snapshot;
  const msg = JSON.stringify({ type: 'snapshot', payload });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const m = req.method;

  if (p === '/health') return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });

  if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
  if (rateLimited(req.socket.remoteAddress || '?')) return json(res, 429, { error: 'rate limited' });

  try {
    const raw = m === 'POST' || m === 'PUT' ? await readBody(req) : '';

    if (p === '/bans' && m === 'GET') return json(res, 200, db.bans);

    if (p === '/bans' && m === 'POST') {
      const body = JSON.parse(raw);
      if (!body || !body.name) return json(res, 400, { error: 'name required' });
      const row = {
        name: String(body.name),
        roblox_id: body.roblox_id != null ? String(body.roblox_id) : null,
        reason: String(body.reason || ''),
        banned_by: String(body.banned_by || ''),
        banned_by_id: String(body.banned_by_id || ''),
        created_at: String(body.created_at || new Date().toISOString()),
      };
      const i = db.bans.findIndex((b) => b.name.toLowerCase() === row.name.toLowerCase());
      if (i >= 0) { row.created_at = db.bans[i].created_at; db.bans[i] = row; }
      else db.bans.push(row);
      save();
      console.log(`[api] ban upserted: ${row.name}`);
      return json(res, 200, { ok: true, name: row.name });
    }

    if (p === '/bans' && m === 'DELETE') {
      const name = String(u.searchParams.get('name') || '');
      if (!name) return json(res, 400, { error: 'name required' });
      const before = db.bans.length;
      db.bans = db.bans.filter((b) => b.name.toLowerCase() !== name.toLowerCase());
      save();
      const removed = db.bans.length < before;
      console.log(`[api] ban deleted: ${name} removed=${removed}`);
      return json(res, 200, { ok: true, removed });
    }

    if (p === '/announcements' && m === 'POST') {
      const body = JSON.parse(raw);
      const text = String(body && body.text || '').trim();
      if (!text) return json(res, 400, { error: 'text required' });
      const row = { id: db.announcements.nextId++, text, created_at: new Date().toISOString() };
      db.announcements.rows.push(row);
      save();
      console.log(`[api] announcement #${row.id}: ${row.text}`);
      return json(res, 200, { id: row.id });
    }

    if (p === '/announcements/latest' && m === 'GET') {
      return json(res, 200, latest('announcements', ['id', 'text']));
    }

    if (p === '/commands' && m === 'POST') {
      const body = JSON.parse(raw);
      const command = String(body && body.command || '').trim();
      if (!command) return json(res, 400, { error: 'command required' });
      const row = { id: db.commands.nextId++, command, created_at: new Date().toISOString() };
      db.commands.rows.push(row);
      save();
      console.log(`[api] command #${row.id}: ${row.command}`);
      return json(res, 200, { id: row.id });
    }

    if (p === '/commands/latest' && m === 'GET') {
      return json(res, 200, latest('commands', ['id', 'command']));
    }

    if (p === '/snapshot' && m === 'GET') {
      return json(res, 200, { data: db.snapshot });
    }

    if (p === '/snapshot' && m === 'POST') {
      db.snapshot = raw;
      save();
      broadcastSnapshot();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 400, { error: 'bad request' });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  if (!authed(req)) {
    ws.close(1008, 'unauthorized');
    return;
  }
  console.log('[api] ws client connected');
  ws.on('close', () => console.log('[api] ws client disconnected'));
  if (db.snapshot) {
    ws.send(JSON.stringify({ type: 'snapshot', payload: parseSnapshot(db.snapshot) ?? db.snapshot }));
  }
});

if (!TOKEN) {
  console.error('[api] FATAL: API_TOKEN is not set in .env - refusing to start insecure.');
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} (db=${DB_FILE})`);
});
