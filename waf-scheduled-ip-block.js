// Scheduled per-IP time-of-day access windows for the "IP đang bị chặn" / WAF page's "Chặn theo giờ"
// tab — "IP X is only allowed through during [allowed_start, allowed_end); banned via fail2ban
// outside that window" (routes/waf.js's /scheduled-ip-blocks CRUD, database.js's
// waf_scheduled_ip_blocks table).
//
// IMPORTANT SCOPE LIMIT: this enforces at the VM/jail level via the SAME fail2ban jail
// (waf-manager.js's netadmin-waf) every other WAF ban already uses — banIp/unbanIp operate on
// iptables/nftables, which has no concept of virtual hosts (domains sharing one IP:port via the
// HTTP Host header). A rule's `domain` field is a human-readable LABEL for what this IP is meant to
// access, NOT an enforced scope — if the VM hosts other domains too, this blocks the IP from ALL of
// them, not just the named one. True per-domain scoping would mean generating/pushing nginx config
// per rule and reloading nginx (a much bigger, higher-blast-radius mechanism) — not implemented here,
// by explicit choice after confirming with the user that VM-level blocking is what they wanted.
//
// Reuses waf-manager.js's banIp/unbanIp directly — no new SSH/fail2ban logic, no second ban
// mechanism, same as every other WAF auto-block path in this codebase.
const db = require('./database');
const wafManager = require('./waf-manager');

function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// "HH:MM:SS" (MySQL TIME) compared as plain strings against the current wall-clock time in the
// same zone every other collector in this codebase uses — avoids Date object timezone pitfalls
// entirely by never constructing one for the comparison itself.
function currentTimeOfDay() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}

// Handles windows that cross midnight (e.g. 22:00:00 -> 06:00:00): if start <= end, allowed is the
// normal "between" case; otherwise allowed is "at or after start, OR before end".
function isWithinWindow(now, start, end) {
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end;
}

async function applyRule(rule) {
  const now = currentTimeOfDay();
  const allowed = isWithinWindow(now, rule.allowed_start, rule.allowed_end);
  const desiredState = allowed ? 'allowed' : 'blocked';
  if (rule.last_state === desiredState) return; // already in the right state, nothing to do

  const vm = await db.prepare('SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?').get(rule.vm_id);
  if (!vm || !vm.ssh_credential_id) {
    await db.prepare('UPDATE waf_scheduled_ip_blocks SET last_error = ? WHERE id = ?')
      .run('VM chưa gán tài khoản kết nối SSH', rule.id);
    return;
  }

  const result = desiredState === 'blocked'
    ? await wafManager.banIp(vm, rule.ip)
    : await wafManager.unbanIp(vm, rule.ip);

  if (!result.ok) {
    const err = result.excepted ? 'IP nằm trong danh sách Ngoại lệ — không thể chặn' : (result.error || 'Lỗi không rõ');
    await db.prepare('UPDATE waf_scheduled_ip_blocks SET last_error = ? WHERE id = ?').run(err, rule.id);
    return;
  }

  await db.prepare('UPDATE waf_scheduled_ip_blocks SET last_state = ?, last_applied_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?')
    .run(desiredState, rule.id);
  await db.prepare(`
    INSERT INTO activity_logs (action, entity_type, entity_id, entity_name, details, user_name)
    VALUES ('UPDATE', 'vcenter_vm', ?, ?, ?, 'System (lịch chặn theo giờ)')
  `).run(vm.id, vm.name, `${desiredState === 'blocked' ? 'Chặn' : 'Gỡ chặn'} IP ${rule.ip} theo lịch giờ (${rule.domain || 'không ghi nhãn domain'}: ${rule.allowed_start}-${rule.allowed_end})`);
}

async function tick() {
  const rules = await db.prepare('SELECT * FROM waf_scheduled_ip_blocks WHERE enabled = 1').all();
  for (const rule of rules) {
    try {
      await applyRule(rule);
    } catch (e) {
      console.error(`[waf-sched-block] Lỗi áp dụng rule #${rule.id} (${rule.ip}): ${e.message}`);
    }
  }
}

function start(intervalMs = 60000) {
  const t = () => tick().catch((e) => console.error('[waf-sched-block] Lỗi tick:', e.message));
  t();
  return setInterval(t, intervalMs);
}

module.exports = { start, tick, isWithinWindow, currentTimeOfDay };
