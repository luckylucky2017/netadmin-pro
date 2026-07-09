// Syncs VM inventory + live utilization from vCenter into vcenter_vms.
// Read-only: only ever issues GET/POST session, PropertyCollector reads, and QueryPerf —
// never touches VM power state or config.
const db = require('./database');
const client = require('./vcenter-client');

// IP + OS family reported by VMware Tools — only available while the VM is powered on and Tools
// is running. Used to enable SSH-based security monitoring without asking the user to type IPs by hand.
async function guestIdentity(moref) {
  const identity = await client.rest('GET', `/api/vcenter/vm/${moref}/guest/identity`);
  return { ip_address: identity?.ip_address || null, guest_family: identity?.family || null };
}

async function guestDiskPct(moref) {
  const fs = await client.rest('GET', `/api/vcenter/vm/${moref}/guest/local-filesystem`);
  const mounts = Object.values(fs || {});
  if (!mounts.length) return null;
  const totalCap = mounts.reduce((s, m) => s + (m.capacity || 0), 0);
  const totalFree = mounts.reduce((s, m) => s + (m.free_space || 0), 0);
  if (!totalCap) return null;
  return Math.round(((totalCap - totalFree) / totalCap) * 1000) / 10;
}

// Counter IDs (cpu.usage.average / mem.usage.average) are looked up once, not hardcoded,
// since they can differ across vCenter installations.
let counterIds = null; // { cpu: <id>, mem: <id> }

async function loadCounterIds() {
  const xml = await client.soap(`<vim25:RetrievePropertiesEx>
    <vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
    <vim25:specSet>
      <vim25:propSet><vim25:type>PerformanceManager</vim25:type><vim25:pathSet>perfCounter</vim25:pathSet></vim25:propSet>
      <vim25:objectSet><vim25:obj type="PerformanceManager">PerfMgr</vim25:obj></vim25:objectSet>
    </vim25:specSet>
    <vim25:options></vim25:options>
  </vim25:RetrievePropertiesEx>`);

  const ids = {};
  const blocks = xml.match(/<PerfCounterInfo[^>]*>.*?<\/PerfCounterInfo>/gs) || [];
  for (const b of blocks) {
    const id = /^<PerfCounterInfo[^>]*><key>(\d+)<\/key>/.exec(b)?.[1];
    const group = /<groupInfo>.*?<key>([a-zA-Z0-9]+)<\/key>.*?<\/groupInfo>/s.exec(b)?.[1];
    const name = /<nameInfo>.*?<key>([a-zA-Z0-9]+)<\/key>.*?<\/nameInfo>/s.exec(b)?.[1];
    const rollup = /<rollupType>([a-zA-Z]+)<\/rollupType>/.exec(b)?.[1];
    if (!id || rollup !== 'average') continue;
    if (group === 'cpu' && name === 'usage') ids.cpu = id;
    if (group === 'mem' && name === 'usage') ids.mem = id;
  }
  counterIds = ids;
}

async function vmPerf(moref) {
  if (!counterIds) await loadCounterIds();
  if (!counterIds.cpu || !counterIds.mem) return {};

  const xml = await client.soap(`<vim25:QueryPerf>
    <vim25:_this type="PerformanceManager">PerfMgr</vim25:_this>
    <vim25:querySpec>
      <vim25:entity type="VirtualMachine">${moref}</vim25:entity>
      <vim25:maxSample>1</vim25:maxSample>
      <vim25:metricId><vim25:counterId>${counterIds.cpu}</vim25:counterId><vim25:instance></vim25:instance></vim25:metricId>
      <vim25:metricId><vim25:counterId>${counterIds.mem}</vim25:counterId><vim25:instance></vim25:instance></vim25:metricId>
      <vim25:intervalId>20</vim25:intervalId>
    </vim25:querySpec>
  </vim25:QueryPerf>`);

  const result = {};
  for (const [, cid, val] of xml.matchAll(/<counterId>(\d+)<\/counterId>.*?<value>(-?\d+)<\/value>/gs)) {
    const n = Number(val) / 100;
    if (n < 0) continue; // -1 means "no data yet" (VM just started, or stats not collected this interval)
    if (cid === counterIds.cpu) result.cpu_pct = n;
    if (cid === counterIds.mem) result.mem_pct = n;
  }
  return result;
}

// ── Inventory sync (REST) ──
async function syncVMs() {
  if (!client.configured()) {
    console.warn('[vcenter] Chưa cấu hình VCENTER_HOST/VCENTER_USER/VCENTER_PASSWORD trong .env — bỏ qua đồng bộ.');
    return { skipped: true };
  }
  const vms = await client.rest('GET', '/api/vcenter/vm');
  const upsert = db.prepare(`
    INSERT INTO vcenter_vms (moref, name, power_state, cpu_count, memory_mib, last_synced_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name), power_state = VALUES(power_state),
      cpu_count = VALUES(cpu_count), memory_mib = VALUES(memory_mib),
      last_synced_at = CURRENT_TIMESTAMP
  `);
  await Promise.all(vms.map(vm => upsert.run(vm.vm, vm.name, vm.power_state, vm.cpu_count, vm.memory_size_MiB)));

  // Rows for VMs deleted directly in vCenter since the last sync shouldn't linger forever.
  const currentMorefs = new Set(vms.map(vm => vm.vm));
  const known = await db.prepare('SELECT moref FROM vcenter_vms').all();
  const stale = db.prepare('DELETE FROM vcenter_vms WHERE moref = ?');
  await Promise.all(known.filter(({ moref }) => !currentMorefs.has(moref)).map(({ moref }) => stale.run(moref)));

  return { count: vms.length };
}

// ── Utilization sync (SOAP perf + REST guest disk) — only meaningful for running VMs ──
const STATS_CONCURRENCY = 8;

async function syncStats() {
  if (!client.configured()) return { skipped: true };
  const vms = await db.prepare("SELECT id, moref FROM vcenter_vms WHERE power_state = 'POWERED_ON'").all();
  const update = db.prepare('UPDATE vcenter_vms SET cpu_pct=?, mem_pct=?, disk_pct=?, stats_updated_at=CURRENT_TIMESTAMP WHERE moref=?');
  const insertHistory = db.prepare('INSERT INTO vm_metrics_history (vm_id, cpu_pct, mem_pct, disk_pct) VALUES (?, ?, ?, ?)');
  const updateIdentity = db.prepare('UPDATE vcenter_vms SET ip_address=?, guest_family=? WHERE moref=?');

  let ok = 0, failed = 0;
  async function collectOne(vm) {
    try {
      const [perf, disk, identity] = await Promise.all([
        vmPerf(vm.moref).catch(() => ({})),
        guestDiskPct(vm.moref).catch(() => null),
        guestIdentity(vm.moref).catch(() => null)
      ]);
      await update.run(perf.cpu_pct ?? null, perf.mem_pct ?? null, disk, vm.moref);
      await insertHistory.run(vm.id, perf.cpu_pct ?? null, perf.mem_pct ?? null, disk);
      if (identity) await updateIdentity.run(identity.ip_address, identity.guest_family, vm.moref);
      ok++;
    } catch {
      failed++;
    }
  }
  for (let i = 0; i < vms.length; i += STATS_CONCURRENCY) {
    await Promise.all(vms.slice(i, i + STATS_CONCURRENCY).map(collectOne));
  }
  await db.prepare("DELETE FROM vm_metrics_history WHERE recorded_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)").run();
  return { ok, failed };
}

// Self-rescheduling (not setInterval) so a slow cycle — e.g. many VMs — never overlaps the next one.
function start(intervalMs = 60000) {
  let stopped = false;
  async function tick() {
    try { await syncVMs(); } catch (e) { console.error('[vcenter] Lỗi đồng bộ inventory:', e.message); }
    try { await syncStats(); } catch (e) { console.error('[vcenter] Lỗi đồng bộ utilization:', e.message); }
    if (!stopped) setTimeout(tick, intervalMs);
  }
  tick();
  return { stop: () => { stopped = true; } };
}

module.exports = { start, syncVMs, syncStats, vmPerf, guestDiskPct, guestIdentity };
