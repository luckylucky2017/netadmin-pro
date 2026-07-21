// Thin wrapper around node-routeros's RouterOSAPI (the legacy binary API protocol RouterOS v6.x
// speaks on port 8728/8729 — there is no REST/HTTP API at all before RouterOS v7.1). Every caller
// goes through withConnection() so a connection is always opened fresh, used for exactly one
// request/collection cycle, and closed — mirrors pfsense-client.js's per-call request() shape
// closely enough that mikrotik-collector.js/routes/mikrotik.js read the same way, but this
// protocol has no persistent-session/cookie concept to reuse across calls the way pfSense's REST
// API does, so there's no connection-pooling equivalent to build here.
const { RouterOSAPI } = require('node-routeros');

const CONNECT_TIMEOUT_SEC = 10;

async function withConnection(fw, fn) {
  const conn = new RouterOSAPI({
    host: fw.host,
    user: fw.username,
    password: fw.password || '',
    port: fw.port || 8728,
    timeout: CONNECT_TIMEOUT_SEC,
  });
  try {
    await conn.connect();
    return await fn(conn);
  } finally {
    try { await conn.close(); } catch { /* already closed/never fully opened — nothing to clean up */ }
  }
}

async function testConnection(fw) {
  try {
    const identity = await withConnection(fw, (conn) => conn.write('/system/identity/print'));
    return { ok: true, identity: identity[0]?.name || null };
  } catch (e) {
    return { ok: false, error: e.message || 'Không kết nối được tới MikroTik' };
  }
}

module.exports = { withConnection, testConnection };
