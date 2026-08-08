const { API_URL, API_TOKEN } = require('../config');

async function call(method, route, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(API_URL + route, {
      method,
      headers: {
        'x-api-token': API_TOKEN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`API ${method} ${route} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getBans: () => call('GET', '/bans'),
  upsertBan: (b) => call('POST', '/bans', b),
  deleteBan: (name) => call('DELETE', `/bans?name=${encodeURIComponent(name)}`),
  postAnnouncement: (text) => call('POST', '/announcements', { text }),
  postCommand: (command) => call('POST', '/commands', { command }),
  getSnapshot: () => call('GET', '/snapshot'),
};