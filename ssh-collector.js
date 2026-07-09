// Collects real CPU/RAM/Disk usage from Linux servers via SSH and writes to metrics_history —
// same table/shape as metrics-simulator.js, so the alert engine and UI don't care which one filled it.
// Only servers with ssh_user configured are collected here; metrics-simulator.js covers the rest.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { NodeSSH } = require('node-ssh');
const db = require('./database');

const KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_rsa');
const KEY_AVAILABLE = fs.existsSync(KEY_PATH);

// Two /proc/stat samples 1s apart give an accurate instantaneous CPU% without needing `mpstat`/`bc`.
const COLLECT_SCRIPT = `
read -r _ u1 n1 s1 i1 w1 _ < /proc/stat
sleep 1
read -r _ u2 n2 s2 i2 w2 _ < /proc/stat
t1=$((u1+n1+s1+i1+w1)); t2=$((u2+n2+s2+i2+w2)); dt=$((t2-t1)); di=$((i2-i1))
CPU=$(awk -v dt="$dt" -v di="$di" 'BEGIN{ if (dt>0) printf "%.1f", 100*(1-di/dt); else print "0" }')
RAM=$(free -m | awk '/Mem:/ {printf "%.1f", $3/$2*100}')
DISK=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
echo "CPU:$CPU"
echo "RAM:$RAM"
echo "DISK:$DISK"
`.trim();

function parseMetrics(stdout) {
  const values = {};
  stdout.split('\n').forEach(line => {
    const m = line.match(/^(CPU|RAM|DISK):([\d.]+)/);
    if (m) values[m[1]] = parseFloat(m[2]);
  });
  return values;
}

async function collectServer(server) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: server.ip_address,
      port: server.ssh_port || 22,
      username: server.ssh_user,
      privateKeyPath: KEY_PATH,
      passphrase: process.env.SSH_PASSPHRASE || undefined,
      readyTimeout: 8000
    });
    const result = await ssh.execCommand(COLLECT_SCRIPT);
    if (result.code !== 0) throw new Error(result.stderr || `Lệnh thoát với code ${result.code}`);
    const v = parseMetrics(result.stdout);
    if (v.CPU == null && v.RAM == null && v.DISK == null) throw new Error('Không đọc được số liệu từ output');
    await db.prepare('INSERT INTO metrics_history (server_id, cpu_pct, ram_pct, disk_pct) VALUES (?, ?, ?, ?)')
      .run(server.id, v.CPU ?? null, v.RAM ?? null, v.DISK ?? null);
  } catch (e) {
    console.error(`[ssh-collector] ${server.name} (${server.ip_address}): ${e.message}`);
  } finally {
    ssh.dispose();
  }
}

async function collectAll() {
  if (!KEY_AVAILABLE) {
    console.warn(`[ssh-collector] Không tìm thấy private key tại ${KEY_PATH} — bỏ qua thu thập SSH (server không có ssh_user vẫn dùng dữ liệu mô phỏng). Đặt SSH_PRIVATE_KEY_PATH trong .env nếu key ở nơi khác.`);
    return;
  }
  const servers = await db.prepare("SELECT * FROM servers WHERE status != 'offline' AND ssh_user IS NOT NULL AND ssh_user != ''").all();
  if (!servers.length) return;
  await Promise.allSettled(servers.map(collectServer));
}

function start(intervalMs = 30000) {
  // Wrapped in .catch — see alert-engine.js's start() for why (async setInterval + network DB).
  const tick = () => collectAll().catch(e => console.error('[ssh-collector] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, collectAll, collectServer, parseMetrics };
