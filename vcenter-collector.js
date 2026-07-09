// Syncs VM inventory + live utilization from every enabled vCenter cluster into vcenter_vms.
// Read-only: only ever issues GET/POST session, PropertyCollector reads, and QueryPerf —
// never touches VM power state or config.
const db = require('./database');
const client = require('./vcenter-client');
const registry = require('./vcenter-registry');

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

// Counter IDs (cpu.usage.average / mem.usage.average) are looked up once per cluster, not
// hardcoded — they can differ across vCenter installations, so a single shared cache would be
// wrong the moment a 2nd cluster with different IDs is added.
const counterIdsByCluster = new Map(); // clusterId -> { cpu: <id>, mem: <id> }

async function loadCounterIds(clusterId) {
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
  counterIdsByCluster.set(clusterId, ids);
}

async function vmPerf(clusterId, moref) {
  if (!counterIdsByCluster.has(clusterId)) await loadCounterIds(clusterId);
  const counterIds = counterIdsByCluster.get(clusterId);
  if (!counterIds?.cpu || !counterIds?.mem) return {};

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

// ── Inventory sync (REST) — one cluster ──
async function syncOneCluster(cluster) {
  return registry.withClient(cluster.id, async () => {
    const vms = await client.rest('GET', '/api/vcenter/vm');
    const upsert = db.prepare(`
      INSERT INTO vcenter_vms (moref, name, power_state, cpu_count, memory_mib, vcenter_cluster_id, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name), power_state = VALUES(power_state),
        cpu_count = VALUES(cpu_count), memory_mib = VALUES(memory_mib),
        last_synced_at = CURRENT_TIMESTAMP
    `);
    await Promise.all(vms.map(vm => upsert.run(vm.vm, vm.name, vm.power_state, vm.cpu_count, vm.memory_size_MiB, cluster.id)));

    // Rows for VMs deleted directly in vCenter since the last sync shouldn't linger forever —
    // scoped to THIS cluster's morefs only, since a moref that's stale in cluster A may coincide
    // with a perfectly live moref in cluster B.
    const currentMorefs = new Set(vms.map(vm => vm.vm));
    const known = await db.prepare('SELECT moref FROM vcenter_vms WHERE vcenter_cluster_id = ?').all(cluster.id);
    const stale = db.prepare('DELETE FROM vcenter_vms WHERE vcenter_cluster_id = ? AND moref = ?');
    await Promise.all(known.filter(({ moref }) => !currentMorefs.has(moref)).map(({ moref }) => stale.run(cluster.id, moref)));

    await db.prepare("UPDATE vcenter_clusters SET status='ok', last_synced_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?").run(cluster.id);
    return { clusterId: cluster.id, count: vms.length };
  }).catch(async e => {
    // 1 cluster being unreachable/misconfigured must never stop the others from syncing.
    await db.prepare("UPDATE vcenter_clusters SET status='error', last_error=? WHERE id=?").run(e.message, cluster.id);
    return { clusterId: cluster.id, error: e.message };
  });
}

async function syncVMs() {
  const clusters = await registry.getEnabledClusters();
  if (!clusters.length) {
    console.warn('[vcenter] Chưa có cụm vCenter nào được bật — bỏ qua đồng bộ. Vào trang vCenter > tab Cụm vCenter để thêm.');
    return { skipped: true };
  }
  const results = await Promise.all(clusters.map(syncOneCluster));
  return { clusters: results };
}

// ── Utilization sync (SOAP perf + REST guest disk) — only meaningful for running VMs, per cluster ──
const STATS_CONCURRENCY = 8;

async function syncStatsForCluster(cluster) {
  return registry.withClient(cluster.id, async () => {
    const vms = await db.prepare("SELECT id, moref FROM vcenter_vms WHERE power_state = 'POWERED_ON' AND vcenter_cluster_id = ?").all(cluster.id);
    const update = db.prepare('UPDATE vcenter_vms SET cpu_pct=?, mem_pct=?, disk_pct=?, stats_updated_at=CURRENT_TIMESTAMP WHERE moref=? AND vcenter_cluster_id=?');
    const insertHistory = db.prepare('INSERT INTO vm_metrics_history (vm_id, cpu_pct, mem_pct, disk_pct) VALUES (?, ?, ?, ?)');
    const updateIdentity = db.prepare('UPDATE vcenter_vms SET ip_address=?, guest_family=? WHERE moref=? AND vcenter_cluster_id=?');

    let ok = 0, failed = 0;
    async function collectOne(vm) {
      try {
        const [perf, disk, identity] = await Promise.all([
          vmPerf(cluster.id, vm.moref).catch(() => ({})),
          guestDiskPct(vm.moref).catch(() => null),
          guestIdentity(vm.moref).catch(() => null)
        ]);
        await update.run(perf.cpu_pct ?? null, perf.mem_pct ?? null, disk, vm.moref, cluster.id);
        await insertHistory.run(vm.id, perf.cpu_pct ?? null, perf.mem_pct ?? null, disk);
        if (identity) await updateIdentity.run(identity.ip_address, identity.guest_family, vm.moref, cluster.id);
        ok++;
      } catch {
        failed++;
      }
    }
    for (let i = 0; i < vms.length; i += STATS_CONCURRENCY) {
      await Promise.all(vms.slice(i, i + STATS_CONCURRENCY).map(collectOne));
    }
    return { clusterId: cluster.id, ok, failed };
  }).catch(e => ({ clusterId: cluster.id, ok: 0, failed: 0, error: e.message }));
}

async function syncStats() {
  const clusters = await registry.getEnabledClusters();
  if (!clusters.length) return { skipped: true };
  const results = await Promise.all(clusters.map(syncStatsForCluster));
  await db.prepare("DELETE FROM vm_metrics_history WHERE recorded_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)").run();
  const ok = results.reduce((s, r) => s + (r.ok || 0), 0);
  const failed = results.reduce((s, r) => s + (r.failed || 0), 0);
  return { ok, failed, clusters: results };
}

// Self-rescheduling (not setInterval) so a slow cycle — e.g. many VMs across many clusters — never
// overlaps the next one.
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

module.exports = { start, syncVMs, syncStats, syncOneCluster, vmPerf, guestDiskPct, guestIdentity };
