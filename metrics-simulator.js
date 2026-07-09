// Simulates CPU/RAM/Disk metrics for servers that don't have real SSH credentials configured yet.
// Servers with ssh_user set are collected for real by ssh-collector.js instead — same
// metrics_history table, same shape (server_id, cpu_pct, ram_pct, disk_pct).
const db = require('./database');

const state = {};

function randomWalk(prev, min, max, volatility) {
  const next = prev + (Math.random() - 0.5) * volatility;
  return Math.max(min, Math.min(max, next));
}

async function tick() {
  const servers = await db.prepare("SELECT id FROM servers WHERE status != 'offline' AND (ssh_user IS NULL OR ssh_user = '')").all();
  const insert = db.prepare('INSERT INTO metrics_history (server_id, cpu_pct, ram_pct, disk_pct) VALUES (?, ?, ?, ?)');
  for (const s of servers) {
    const st = state[s.id] || (state[s.id] = { cpu: 30 + Math.random() * 20, ram: 40 + Math.random() * 20, disk: 50 + Math.random() * 20 });
    st.cpu = randomWalk(st.cpu, 5, 99, 8);
    st.ram = randomWalk(st.ram, 10, 97, 5);
    st.disk = randomWalk(st.disk, 20, 98, 1.5);
    await insert.run(s.id, Math.round(st.cpu * 10) / 10, Math.round(st.ram * 10) / 10, Math.round(st.disk * 10) / 10);
  }
  await db.prepare("DELETE FROM metrics_history WHERE recorded_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)").run();
}

function start(intervalMs = 5000) {
  // Wrapped in .catch — see alert-engine.js's start() for why (async setInterval + network DB).
  const safeTick = () => tick().catch(e => console.error('[metrics-simulator] Lỗi:', e.message));
  safeTick();
  return setInterval(safeTick, intervalMs);
}

module.exports = { start, tick };
