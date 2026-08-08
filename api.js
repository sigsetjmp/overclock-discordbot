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
const ALLOWED_ROLES = new Set(['lua', 'bot']);

function emptyDB() {
  return {
    bans: [],
    announcements: { nextId: 1, rows: [] },
    commands: { nextId: 1, rows: [] },
    snapshot: null,
  };
}

// old clients may have stored a double-encoded snapshot string; unwrap it
function normalizeSnapshot(s) {
  try {
    const first = JSON.parse(s);
    if (typeof first === 'string') return first;
    return s;
  } catch {
    return s;
  }
}

function loadDB() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const base = emptyDB();
    return {
      bans: Array.isArray(parsed.bans) ? parsed.bans : base.bans,
      announcements: parsed.announcements && Array.isArray(parsed.announcements.rows) ? parsed.announcements : base.announcements,
      commands: parsed.commands && Array.isArray(parsed.commands.rows) ? parsed.commands : base.commands,
      snapshot: typeof parsed.snapshot === 'string' ? normalizeSnapshot(parsed.snapshot) : null,
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

function lastRow(key) {
  const rows = db[key].rows;
  return rows.length ? rows[rows.length - 1] : null;
}

function parseSnapshot(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function sendToRoles(roles, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && roles.includes(ws.role)) ws.send(msg);
  }
}

function broadcastSnapshot() {
  sendToRoles(['bot'], { type: 'snapshot', payload: parseSnapshot(db.snapshot) ?? db.snapshot });
}

function broadcastBans() {
  sendToRoles(['lua'], { type: 'bans', bans: db.bans });
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
      broadcastBans();
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
      if (removed) broadcastBans();
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
      sendToRoles(['lua'], { type: 'announcement', id: row.id, text: row.text });
      console.log(`[api] announcement #${row.id}: ${row.text}`);
      return json(res, 200, { id: row.id });
    }

    if (p === '/announcements/latest' && m === 'GET') {
      const last = lastRow('announcements');
      return json(res, 200, last ? { id: last.id, text: last.text } : { id: 0, text: '' });
    }

    if (p === '/commands' && m === 'POST') {
      const body = JSON.parse(raw);
      const command = String(body && body.command || '').trim();
      if (!command) return json(res, 400, { error: 'command required' });
      const row = { id: db.commands.nextId++, command, created_at: new Date().toISOString() };
      db.commands.rows.push(row);
      save();
      sendToRoles(['lua'], { type: 'command', id: row.id, command: row.command });
      console.log(`[api] command #${row.id}: ${row.command}`);
      return json(res, 200, { id: row.id });
    }

    if (p === '/commands/latest' && m === 'GET') {
      const last = lastRow('commands');
      return json(res, 200, last ? { id: last.id, command: last.command } : { id: 0, command: '' });
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
  const u = new URL(req.url, 'http://x');
  const role = u.searchParams.get('role') || 'bot';
  if (!ALLOWED_ROLES.has(role)) {
    ws.close(1008, 'invalid role');
    return;
  }
  ws.role = role;
  console.log(`[api] ws client connected (role=${role})`);
  ws.on('close', () => console.log(`[api] ws client disconnected (role=${role})`));

  if (role === 'lua') {
    ws.send(JSON.stringify({
      type: 'init',
      bans: db.bans,
      announcement: lastRow('announcements'),
      command: lastRow('commands'),
    }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || msg.type !== 'snapshot' || !msg.data || typeof msg.data !== 'object') return;
      db.snapshot = JSON.stringify(msg.data);
      save();
      broadcastSnapshot();
    });
  } else if (db.snapshot) {
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
