require('dotenv').config();
const path = require('path');

module.exports = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || '',
  API_URL: (process.env.API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
  API_TOKEN: process.env.API_TOKEN || '',

  ROLES: {
    TRIAL_MOD: '1535026371523248348',
    MOD: '1535025679756951673',
    ADMIN: '1535025627055259740',
    OWNER: '1535025513410728147',
  },
  TICKET_PING_ROLE: '1535039121519542283',
  SUPPORT_ROLE: '1535039121519542283',
  TICKET_CATEGORY: '1535029532854194206',
  LOG_CHANNEL: '1535028352157745162',
  LIVE_CHANNEL: '1535265091099033720',
  SERVER_LINK: 'https://www.roblox.com/share?code=8a7cc21269b33242abf49c8e4e2b8dc5&type=Server',

  TICKETS_FILE: path.join(__dirname, 'tickets.json'),
  LIVE_MSG_FILE: path.join(__dirname, 'live-msg.json'),

  LIVE_POLL_MS: 5000,
  LIVE_STALE_MS: 15000,

  DUR_NAMES: {
    60000: '60s', 300000: '5m', 600000: '10m', 1800000: '30m',
    3600000: '1h', 7200000: '2h', 14400000: '4h', 28800000: '8h',
    57600000: '16h', 86400000: '24h', 604800000: '1w',
  },
};