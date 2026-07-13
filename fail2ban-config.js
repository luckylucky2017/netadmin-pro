// Resolves the "effective" fail2ban detection thresholds + bantime for a given VM by merging the
// single global default row (fail2ban_config, id=1) with that VM's optional per-field override
// (fail2ban_config_overrides) — see database.js for both tables' shape. Used by:
//   - ssh-security-collector.js's checkBruteForce (ssh_* fields)
//   - nginx-waf-collector.js's detectPerIpEvents/detectDdos (waf_* fields)
//   - fail2ban-manager.js/waf-manager.js when pushing bantime into the actual jail.d files on a VM
//   - routes/fail2ban-config.js, the admin page's own read/write API
// Kept as its own module (not folded into database.js) so the collectors and managers can require
// just this, without pulling in the DB schema-definition code.
const db = require('./database');

// Same defaults as the DB column DEFAULTs (database.js's CREATE TABLE fail2ban_config) — duplicated
// here only as the safety-net fallback for getGlobalConfig() below, in case the seed row is ever
// missing (e.g. a fresh DB before ensureSchemaAndMigrations' INSERT IGNORE has run); the real,
// admin-editable source of truth is always the DB row when present.
const DEFAULTS = {
  ssh_brute_force_window_sec: 60,
  ssh_brute_force_threshold: 5,
  ssh_block_foreign_immediately: 1,
  ssh_bantime_sec: -1,
  waf_scan_error_threshold: 20,
  waf_dos_request_threshold: 50,
  waf_dos_window_sec: 10,
  waf_ddos_multiplier: 5,
  waf_ddos_min_total: 200,
  waf_bantime_sec: -1,
};
const FIELDS = Object.keys(DEFAULTS);

async function getGlobalConfig() {
  const row = await db.prepare('SELECT * FROM fail2ban_config WHERE id = 1').get();
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
}

async function getOverride(vmId) {
  return db.prepare('SELECT * FROM fail2ban_config_overrides WHERE vm_id = ?').get(vmId) || null;
}

async function getAllOverrides() {
  return db.prepare('SELECT * FROM fail2ban_config_overrides').all();
}

// Pure, testable: per-field, a non-null override value wins over the global default. Builds the
// result from FIELDS only (not a spread of `global`) — global is often the raw fail2ban_config DB
// row, which also carries id/updated_at; those have no meaning on a per-VM effective config and
// would otherwise leak through misleadingly (id=1 looking like a VM id, a stale updated_at, etc.).
function mergeConfig(global, override) {
  const out = {};
  for (const key of FIELDS) out[key] = global[key];
  if (override) {
    for (const key of FIELDS) {
      if (override[key] !== null && override[key] !== undefined) out[key] = override[key];
    }
  }
  return out;
}

async function getEffectiveConfig(vmId) {
  const [global, override] = await Promise.all([getGlobalConfig(), vmId ? getOverride(vmId) : null]);
  return mergeConfig(global, override);
}

module.exports = { DEFAULTS, FIELDS, getGlobalConfig, getOverride, getAllOverrides, mergeConfig, getEffectiveConfig };
