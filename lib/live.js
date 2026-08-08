const { WebSocket } = require('ws');
const { EmbedBuilder } = require('discord.js');
const {
  API_URL,
  API_TOKEN,
  LIVE_CHANNEL,
  SERVER_LINK,
  LIVE_POLL_MS,
  LIVE_STALE_MS,
  LIVE_MSG_FILE,
} = require('../config');
const { loadJSON, saveJSON } = require('./store');
const api = require('./apiClient');

function formatStats(p) {
  return `**${p.name}** — Kills: ${p.kills} | Deaths: ${p.deaths} | Damage: ${p.damage} | Heal: ${p.heal}`;
}

function formatPlayerList(list) {
  const lines = list.map(formatStats);
  const MAX = 1000;
  let value = '';
  let kept = 0;
  for (const line of lines) {
    const candidate = kept === 0 ? line : value + '\n' + line;
    if (candidate.length > MAX) break;
    value = candidate;
    kept++;
  }
  const rest = lines.length - kept;
  if (rest > 0) value += (kept > 0 ? '\n' : '') + `+${rest} more`;
  return value;
}

function liveEmbed(players, mvp) {
  const embed = new EmbedBuilder()
    .setColor(0x2c2323)
    .setTitle('Active Server Player List')
    .setDescription(`**Join the server:** [Open Roblox Server](${SERVER_LINK})`);
  if (!players) {
    embed.addFields({ name: 'Status', value: 'Bot is not connected to the game server', inline: false });
    return embed;
  }
  if (players.length === 0) {
    embed.addFields({ name: 'Status', value: 'No players in the server', inline: false });
    return embed;
  }
  let sorted = [...players].sort((a, b) => b.kills - a.kills);
  const mvpEntry = mvp ? sorted.find((p) => p.name === mvp) : undefined;
  if (mvpEntry) {
    sorted = sorted.filter((p) => p.name !== mvpEntry.name);
    embed.addFields(
      { name: 'Server MVP', value: formatStats(mvpEntry), inline: false },
      { name: 'Players', value: formatPlayerList(sorted) || 'No other players', inline: false }
    );
  } else {
    embed.addFields({ name: 'Players', value: formatPlayerList(sorted) || 'No other players', inline: false });
  }
  return embed;
}

function parseSnapshot(snapshot) {
  let parsed = snapshot;
  if (typeof snapshot === 'string') {
    try { parsed = JSON.parse(snapshot); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

class LiveBoard {
  constructor(client) {
    this.client = client;
    this.ws = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.liveMsg = loadJSON(LIVE_MSG_FILE, null);
  }

  start() {
    this.connect();
    this.pollTimer = setInterval(() => this.poll(), LIVE_POLL_MS);
    console.log(`[live] started (ws push + ${LIVE_POLL_MS / 1000}s fallback poll)`);
  }

  connect() {
    const url = API_URL.replace(/^http/, 'ws') + '/ws';
    console.log(`[live] connecting ws ${url}`);
    this.ws = new WebSocket(url, {
      headers: { 'x-api-token': API_TOKEN },
      handshakeTimeout: 5000,
    });
    this.ws.on('open', () => console.log('[live] ws connected'));
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'snapshot') this.handle(parseSnapshot(msg.payload));
    });
    this.ws.on('close', () => {
      console.log('[live] ws closed - fallback polling active');
      this.scheduleReconnect();
    });
    this.ws.on('error', (err) => console.error('[live] ws error:', err.message));
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  async poll() {
    try {
      const res = await api.getSnapshot();
      if (res?.data) this.handle(parseSnapshot(res.data));
    } catch (err) {
      console.error('[live] poll error:', err.message);
    }
  }

  async handle(snapshot) {
    if (!snapshot) return;
    const channel = this.client.channels.cache.get(LIVE_CHANNEL);
    if (!channel?.isTextBased()) return;
    try {
      const msg = await this.ensureMessage(channel);
      const isFresh = Array.isArray(snapshot.players) && (Date.now() / 1000 - (snapshot.ts ?? 0)) < LIVE_STALE_MS / 1000;
      const players = isFresh ? snapshot.players : null;
      const mvp = isFresh ? (snapshot.mvp ?? null) : null;
      await msg.edit({ embeds: [liveEmbed(players, mvp)] });
      console.log(`[live] update: fresh=${isFresh} players=${players?.length ?? 0} mvp=${mvp ?? 'none'}`);
    } catch (err) {
      console.error('[live] board error:', err.message);
    }
  }

  async ensureMessage(channel) {
    if (this.liveMsg?.id) {
      const existing = await channel.messages.fetch(this.liveMsg.id).catch(() => null);
      if (existing) return existing;
    }
    const found = await channel.messages
      .fetch({ limit: 20 })
      .then((msgs) => msgs.find((m) => m.author.id === this.client.user.id && m.embeds[0]?.title === 'Active Server Player List'))
      .catch(() => null);
    if (found) {
      this.liveMsg = { id: found.id };
      saveJSON(LIVE_MSG_FILE, this.liveMsg);
      console.log(`[live] adopted existing board message ${found.id}`);
      return found;
    }
    const sent = await channel.send({ embeds: [liveEmbed(null, null)] });
    this.liveMsg = { id: sent.id };
    saveJSON(LIVE_MSG_FILE, this.liveMsg);
    console.log(`[live] created board message ${sent.id}`);
    return sent;
  }
}

module.exports = { LiveBoard };