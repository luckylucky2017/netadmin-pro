// Opt-in daily auto-update for the CrowdSec hub's installed scenarios/collections/parsers —
// crowdsec_settings.hub_auto_update, default OFF (auto-upgrading detection rules is a behavior
// change to production security tooling, not something to silently enable for every install).
//
// Ticks every 6h (not once a day) so a missed/late tick (app restart, transient SSH failure) is
// retried well within the same day rather than waiting a full 24h — the actual "once a day" pacing
// comes from the last_hub_upgrade_at guard below, not the tick interval itself.
const db = require('./database');
const crowdsecManager = require('./crowdsec-manager');

const MIN_INTERVAL_MS = 23 * 60 * 60 * 1000; // 23h, not 24h — avoids the guard sliding later each day

async function tick() {
  const settings = await db.prepare('SELECT hub_auto_update, last_hub_upgrade_at FROM crowdsec_settings WHERE id = 1').get();
  if (!settings?.hub_auto_update) return;
  if (settings.last_hub_upgrade_at && Date.now() - new Date(settings.last_hub_upgrade_at).getTime() < MIN_INTERVAL_MS) return;

  const vm = await crowdsecManager.getManagedVm();
  if (!vm?.ssh_credential_id) return; // nothing to do until an SSH credential is assigned

  const result = await crowdsecManager.upgradeHub(vm);
  await db.prepare('UPDATE crowdsec_settings SET last_hub_upgrade_at = CURRENT_TIMESTAMP WHERE id = 1').run();
  await db.prepare(`
    INSERT INTO activity_logs (action, entity_type, entity_id, entity_name, details, user_name)
    VALUES ('UPDATE', 'crowdsec_hub', ?, ?, ?, 'System (tự động hàng ngày)')
  `).run(vm.id, vm.name, `Tự động cập nhật hub CrowdSec: ${result.ok ? 'thành công' : 'lỗi'} — ${result.text.slice(0, 400)}`);
  if (!result.ok) console.error(`[crowdsec-hub] Auto-update lỗi trên ${vm.name}: ${result.text.slice(0, 300)}`);
}

function start(intervalMs = 6 * 60 * 60 * 1000) {
  const t = () => tick().catch((e) => console.error('[crowdsec-hub] Lỗi tick auto-update:', e.message));
  t();
  return setInterval(t, intervalMs);
}

module.exports = { start, tick };
