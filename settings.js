// Reads the app_settings singleton row (AI key + SAML/LDAP config) — replaces reading these
// directly from process.env everywhere. Cached in memory (settings are read on every AI call and
// every SSO login attempt, but change rarely) and invalidated by routes/settings.js after a save,
// so an edit takes effect on the very next call without restarting the server.
const db = require('./database');

let cache = null;

async function getSettings() {
  if (!cache) cache = await db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
  return cache;
}

function invalidate() {
  cache = null;
}

module.exports = { getSettings, invalidate };
