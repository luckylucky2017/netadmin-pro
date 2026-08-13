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

// ISO weekday: Monday=1 ... Sunday=7 (matches how days_of_week is stored/sent by the frontend).
function currentIsoWeekday() {
  const wd = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'short' });
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd];
}

function isDayAllowed(daysOfWeek) {
  const days = (daysOfWeek || '1,2,3,4,5,6,7').split(',').map((d) => Number(d.trim()));
  return days.includes(currentIsoWeekday());
}

// Keeps rule.ip's OWN exact-match waf_ip_exceptions row in sync with the schedule: enabled while
// allowed (guarantees the IP truly can't be blocked by ANY detector during its window, not just
// "currently not banned" — the old behavior before this existed), disabled outside it (an enabled
// exception unconditionally overrides every ban attempt, scheduled or not, so leaving it on would
// make "blocked" impossible to actually enforce — exactly the conflict that prompted this). Only
// ever touches a row whose ip TEXT matches rule.ip exactly — never a broader CIDR exception that
// might also happen to cover it; that's a separate, manually-managed concern, and if it blocks a ban
// attempt anyway, that surfaces via last_error like any other failure. Nothing to "turn off" if no
// exception row exists yet, so creation only happens on the allowed side.
async function syncExceptionForRule(rule, allowed) {
  const existing = await db.prepare('SELECT id, enabled FROM waf_ip_exceptions WHERE ip = ?').get(rule.ip);
  const desiredEnabled = allowed ? 1 : 0;
  if (existing) {
    if (existing.enabled === desiredEnabled) return;
    await db.prepare('UPDATE waf_ip_exceptions SET enabled = ? WHERE id = ?').run(desiredEnabled, existing.id);
  } else if (allowed) {
    await db.prepare(`
      INSERT INTO waf_ip_exceptions (ip, note, enabled, created_by) VALUES (?, ?, 1, 'System (lịch chặn theo giờ)')
    `).run(rule.ip, `Tự động theo lịch chặn giờ${rule.domain ? ` — ${rule.domain}` : ''}`);
  }
}

async function applyRule(rule) {
  const now = currentTimeOfDay();
  // A day not in days_of_week is treated as fully outside the window (blocked all day on that day),
  // same as being outside allowed_start/allowed_end on an allowed day — one uniform "not currently
  // allowed" condition, not a separate day-level exception.
  const allowed = isDayAllowed(rule.days_of_week) && isWithinWindow(now, rule.allowed_start, rule.allowed_end);
  const desiredState = allowed ? 'allowed' : 'blocked';
  if (rule.last_state === desiredState) return; // already in the right state, nothing to do

  const vm = await db.prepare('SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?').get(rule.vm_id);
  if (!vm || !vm.ssh_credential_id) {
    await db.prepare('UPDATE waf_scheduled_ip_blocks SET last_error = ? WHERE id = ?')
      .run('VM chưa gán tài khoản kết nối SSH', rule.id);
    return;
  }

  // Must happen BEFORE the ban attempt below: banIp itself refuses to ban any IP currently in an
  // enabled exception (by design, checked via getExceptions()) — disabling it here is what actually
  // makes "blocked" take effect, not just the banIp call on its own.
  await syncExceptionForRule(rule, allowed);
  await wafManager.pushIgnoreIp(vm).catch(() => {}); // best-effort jail-level ignoreip sync, see waf-manager.js's own comment on its limited effect for this specific jail

  let result;
  if (desiredState === 'blocked') {
    result = await wafManager.banIp(vm, rule.ip);
  } else {
    // unbanIp treats "IP wasn't banned to begin with" as a failure (fail2ban's own unbanip returns
    // "0", not "1", when there was nothing to remove — confirmed live during rollout testing) even
    // though the actual desired outcome (IP not banned) already holds. Checking the live banned list
    // first avoids both that false failure (which would otherwise leave last_state stuck at null
    // forever, retrying every tick with nothing to actually do) and an unnecessary SSH round-trip
    // when the IP is already not banned.
    const { ips, error } = await wafManager.listBannedIps(vm);
    if (error) { result = { ok: false, error }; }
    else if (!ips.includes(rule.ip)) { result = { ok: true }; }
    else { result = await wafManager.unbanIp(vm, rule.ip); }
  }

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

module.exports = { start, tick, isWithinWindow, currentTimeOfDay, isDayAllowed, currentIsoWeekday };
