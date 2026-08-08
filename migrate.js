require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

async function fetchAll(url, key) {
  const tables = {
    bans: '/rest/v1/ingame_bans?select=name,roblox_id,reason,banned_by,banned_by_id,created_at&order=created_at.asc',
    announcements: '/rest/v1/ingame_announcements?select=id,text,created_at&order=id.asc',
    commands: '/rest/v1/ingame_commands?select=id,command,created_at&order=id.asc',
    snapshot: '/rest/v1/ingame_snapshot?select=data&id=eq.1',
  };
  const out = {};
  for (const [name, sql] of Object.entries(tables)) {
    const res = await fetch(url + sql, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    out[name] = await res.json();
  }
  return out;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY in .env (migration only - can be removed later).');
    process.exit(1);
  }

  console.log('Fetching current data from Supabase...');
  const data = await fetchAll(url, key);

  let db = {};
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = {}; }

  const summary = [];

  if (!Array.isArray(db.bans) || db.bans.length === 0) {
    db.bans = data.bans || [];
    summary.push(`bans: ${db.bans.length}`);
  } else summary.push('bans: kept (already populated)');

  if (!db.announcements || db.announcements.rows.length === 0) {
    const rows = data.announcements || [];
    const nextId = rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
    db.announcements = { nextId, rows };
    summary.push(`announcements: ${rows.length} (nextId=${nextId})`);
  } else {
    summary.push('announcements: kept (already populated)');
  }

  if (!db.commands || db.commands.rows.length === 0) {
    const rows = data.commands || [];
    const nextId = rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
    db.commands = { nextId, rows };
    summary.push(`commands: ${rows.length} (nextId=${nextId})`);
  } else {
    summary.push('commands: kept (already populated)');
  }

  if (!db.snapshot && data.snapshot?.[0]?.data) {
    db.snapshot = data.snapshot[0].data;
    summary.push('snapshot: migrated');
  } else {
    summary.push('snapshot: kept/none');
  }

  if (!db.bans) db.bans = [];

  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  console.log('Migration complete:');
  for (const line of summary) console.log(' - ' + line);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});