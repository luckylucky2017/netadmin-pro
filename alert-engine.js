// Evaluates enabled alert_rules against recent metrics_history (servers) and
// vm_metrics_history (vCenter VMs), then opens/resolves alerts.
const db = require('./database');

const OPERATORS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b
};

const METRIC_LABEL = { cpu: 'CPU', ram: 'RAM', disk: 'Disk' };
// Server metrics live in metrics_history as cpu_pct/ram_pct/disk_pct; VM metrics live in
// vm_metrics_history as cpu_pct/mem_pct/disk_pct — same 3 concepts, different column names.
const SERVER_METRIC_COLUMN = { cpu: 'cpu_pct', ram: 'ram_pct', disk: 'disk_pct' };
const VM_METRIC_COLUMN = { cpu: 'cpu_pct', ram: 'mem_pct', disk: 'disk_pct' };

function breachedWindow(rows, op, threshold) {
  return rows.length > 0 && rows.every(r => op(r.val, threshold));
}

async function applyBreach({ rule, sourceType, sourceId, sourceName, latest, breached }) {
  const openAlert = await db.prepare(
    "SELECT id FROM alerts WHERE rule_id = ? AND source_id = ? AND source_type = ? AND status != 'resolved'"
  ).get(rule.id, sourceId, sourceType);

  if (breached && !openAlert) {
    const minutes = Math.max(1, Math.round(rule.duration_sec / 60));
    await db.prepare(`
      INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status, rule_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(
      rule.category, rule.severity, `${METRIC_LABEL[rule.metric]} vượt ngưỡng`,
      `${METRIC_LABEL[rule.metric]} ${rule.operator} ${rule.threshold}% liên tục ~${minutes} phút (hiện tại ${latest.toFixed(1)}%)`,
      sourceType, sourceId, sourceName, rule.metric, `${latest.toFixed(1)}%`, rule.id
    );
  } else if (!breached && openAlert) {
    await db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(openAlert.id);
  }
}

async function evaluateServerRule(rule, op) {
  const column = SERVER_METRIC_COLUMN[rule.metric];
  if (!column) return;
  const servers = rule.scope_type === 'server'
    ? await db.prepare('SELECT id, name FROM servers WHERE id = ?').all(rule.scope_id)
    : await db.prepare('SELECT id, name FROM servers').all();

  for (const server of servers) {
    const rows = await db.prepare(
      `SELECT ${column} as val FROM metrics_history WHERE server_id = ? AND recorded_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) ORDER BY recorded_at DESC`
    ).all(server.id, rule.duration_sec);
    if (!rows.length) continue;
    await applyBreach({
      rule, sourceType: 'server', sourceId: server.id, sourceName: server.name,
      latest: rows[0].val, breached: breachedWindow(rows, op, rule.threshold)
    });
  }
}

async function evaluateVmRule(rule, op) {
  const column = VM_METRIC_COLUMN[rule.metric];
  if (!column) return;
  const vms = rule.scope_type === 'vm'
    ? await db.prepare('SELECT id, name FROM vcenter_vms WHERE id = ?').all(rule.scope_id)
    : await db.prepare("SELECT id, name FROM vcenter_vms WHERE power_state = 'POWERED_ON'").all();

  for (const vm of vms) {
    const rows = await db.prepare(
      `SELECT ${column} as val FROM vm_metrics_history WHERE vm_id = ? AND ${column} IS NOT NULL AND recorded_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) ORDER BY recorded_at DESC`
    ).all(vm.id, rule.duration_sec);
    if (!rows.length) continue;
    await applyBreach({
      rule, sourceType: 'vcenter_vm', sourceId: vm.id, sourceName: vm.name,
      latest: rows[0].val, breached: breachedWindow(rows, op, rule.threshold)
    });
  }
}

async function evaluateRule(rule) {
  const op = OPERATORS[rule.operator];
  if (!op) return;
  if (rule.scope_type === 'vm' || rule.scope_type === 'all_vms') await evaluateVmRule(rule, op);
  else await evaluateServerRule(rule, op);
}

async function evaluate() {
  const rules = await db.prepare('SELECT * FROM alert_rules WHERE enabled = 1').all();
  for (const rule of rules) await evaluateRule(rule);
}

function start(intervalMs = 10000) {
  // Wrapped in .catch — evaluate() now hits MySQL over the network on every tick (every 10s), so a
  // transient connection hiccup must not become an unhandled promise rejection (which crashes the
  // whole Node process, unlike a synchronous throw from the old in-process SQLite calls).
  const tick = () => evaluate().catch(e => console.error('[alert-engine] Lỗi đánh giá ngưỡng:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, evaluate };
