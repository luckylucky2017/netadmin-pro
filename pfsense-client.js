// Stateless REST client for pfSense-pkg-API (base path /api/v2). Unlike vcenter-client.js, pfSense
// authenticates every single request independently via a header (Basic Auth or x-api-key) — there is
// no login/session step — so no AsyncLocalStorage context/registry is needed here; every call just
// takes the target firewall row directly.
const https = require('https');

function authHeaders(firewall) {
  if (firewall.auth_type === 'api_key') {
    return { 'x-api-key': firewall.api_key };
  }
  const basic = Buffer.from(`${firewall.username}:${firewall.password}`).toString('base64');
  return { Authorization: `Basic ${basic}` };
}

function request(firewall, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = https.request({
      host: firewall.host,
      port: firewall.port || 443,
      path: `/api/v2${path}`,
      method,
      rejectUnauthorized: !firewall.insecure,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...authHeaders(firewall)
      }
    }, res => {
      let chunks = '';
      res.on('data', d => { chunks += d; });
      res.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = chunks; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const detail = parsed && typeof parsed === 'object' ? (parsed.message || JSON.stringify(parsed)) : String(parsed).slice(0, 200);
          reject(Object.assign(new Error(`pfSense ${method} ${path} -> ${res.statusCode}: ${detail}`), { statusCode: res.statusCode, body: parsed }));
        }
      });
    });
    req.on('error', e => reject(Object.assign(new Error(`Không kết nối được pfSense (${firewall.host}:${firewall.port || 443}): ${e.message}`), { cause: e })));
    if (data) req.write(data);
    req.end();
  });
}

async function testConnection(firewall) {
  const r = await request(firewall, 'GET', '/status/system');
  return r?.data || r;
}

module.exports = { request, testConnection };
