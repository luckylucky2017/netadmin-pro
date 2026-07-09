// Write operations against vCenter: create (empty or clone), edit hardware, power, rename, delete.
// Unlike vcenter-collector.js (read-only), every function here changes real infrastructure state.
const db = require('./database');
const client = require('./vcenter-client');
const { logActivity } = require('./auth');

// ── Placement discovery (for the "Create VM" form) ──
// REST's resource-pool list doesn't support filtering by host in this vCenter version, so the
// host -> resource pool mapping is resolved via SOAP: HostSystem.parent -> ComputeResource.resourcePool.
async function poolByHostViaSoap(hostIds) {
  if (!hostIds.length) return {};
  const parentXml = await client.soap(`<vim25:RetrievePropertiesEx>
    <vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
    <vim25:specSet>
      <vim25:propSet><vim25:type>HostSystem</vim25:type><vim25:pathSet>parent</vim25:pathSet></vim25:propSet>
      ${hostIds.map(id => `<vim25:objectSet><vim25:obj type="HostSystem">${id}</vim25:obj></vim25:objectSet>`).join('')}
    </vim25:specSet>
    <vim25:options></vim25:options>
  </vim25:RetrievePropertiesEx>`);
  const hostToCompute = {};
  for (const o of parentXml.match(/<objects>(.*?)<\/objects>/gs) || []) {
    const hostId = /<obj type="HostSystem">(.*?)<\/obj>/.exec(o)?.[1];
    const computeId = /<val[^>]*>(.*?)<\/val>/.exec(o)?.[1];
    if (hostId && computeId) hostToCompute[hostId] = computeId;
  }

  const computeIds = [...new Set(Object.values(hostToCompute))];
  const poolXml = await client.soap(`<vim25:RetrievePropertiesEx>
    <vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
    <vim25:specSet>
      <vim25:propSet><vim25:type>ComputeResource</vim25:type><vim25:pathSet>resourcePool</vim25:pathSet></vim25:propSet>
      ${computeIds.map(id => `<vim25:objectSet><vim25:obj type="ComputeResource">${id}</vim25:obj></vim25:objectSet>`).join('')}
    </vim25:specSet>
    <vim25:options></vim25:options>
  </vim25:RetrievePropertiesEx>`);
  const computeToPool = {};
  for (const o of poolXml.match(/<objects>(.*?)<\/objects>/gs) || []) {
    const computeId = /<obj type="ComputeResource">(.*?)<\/obj>/.exec(o)?.[1];
    const poolId = /<val[^>]*>(.*?)<\/val>/.exec(o)?.[1];
    if (computeId && poolId) computeToPool[computeId] = poolId;
  }

  return Object.fromEntries(hostIds.map(id => [id, computeToPool[hostToCompute[id]] || null]));
}

// Not every datastore is mounted on every host (e.g. per-host local storage) — REST has no
// filter for this either, so resolved the same way as the resource pool: SOAP HostSystem.datastore.
async function datastoresByHostViaSoap(hostIds) {
  if (!hostIds.length) return {};
  const xml = await client.soap(`<vim25:RetrievePropertiesEx>
    <vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
    <vim25:specSet>
      <vim25:propSet><vim25:type>HostSystem</vim25:type><vim25:pathSet>datastore</vim25:pathSet></vim25:propSet>
      ${hostIds.map(id => `<vim25:objectSet><vim25:obj type="HostSystem">${id}</vim25:obj></vim25:objectSet>`).join('')}
    </vim25:specSet>
    <vim25:options></vim25:options>
  </vim25:RetrievePropertiesEx>`);
  const byHost = {};
  for (const o of xml.match(/<objects>(.*?)<\/objects>/gs) || []) {
    const hostId = /<obj type="HostSystem">(.*?)<\/obj>/.exec(o)?.[1];
    if (!hostId) continue;
    byHost[hostId] = [...o.matchAll(/<ManagedObjectReference type="Datastore"[^>]*>(.*?)<\/ManagedObjectReference>/g)].map(m => m[1]);
  }
  return byHost;
}

async function listPlacement() {
  const [hosts, datastores, networks, folders] = await Promise.all([
    client.rest('GET', '/api/vcenter/host'),
    client.rest('GET', '/api/vcenter/datastore'),
    client.rest('GET', '/api/vcenter/network'),
    client.rest('GET', '/api/vcenter/folder')
  ]);
  const vmFolder = (folders || []).find(f => f.type === 'VIRTUAL_MACHINE' && f.name === 'vm');
  const hostIds = hosts.map(h => h.host);
  const [poolByHost, datastoresByHost] = await Promise.all([
    poolByHostViaSoap(hostIds),
    datastoresByHostViaSoap(hostIds)
  ]);

  return {
    hosts: hosts.map(h => ({ id: h.host, name: h.name, resource_pool: poolByHost[h.host] || null, datastore_ids: datastoresByHost[h.host] || [] })),
    datastores: datastores.map(d => ({ id: d.datastore, name: d.name, free_gb: Math.round(d.free_space / 1073741824), capacity_gb: Math.round(d.capacity / 1073741824) })),
    networks: networks.map(n => ({ id: n.network, name: n.name })),
    vmFolder: vmFolder?.folder || 'group-v4'
  };
}

// Guest OS choices for the "empty VM" wizard. Values marked "confirmed" were read back from real
// VMs in this vCenter's inventory (GET .../vm/{vm} -> guest_OS); the rest are inferred siblings
// from the same vSphere 8 naming scheme and validated live by vCenter at create time if wrong.
const GUEST_OS_GROUPS = [
  { group: 'Linux', options: [
    { id: 'UBUNTU_64', label: 'Ubuntu Linux (64-bit)' },
    { id: 'DEBIAN12_64', label: 'Debian GNU/Linux 12 (64-bit)' },
    { id: 'DEBIAN11_64', label: 'Debian GNU/Linux 11 (64-bit)' },
    { id: 'DEBIAN10_64', label: 'Debian GNU/Linux 10 (64-bit)' },
    { id: 'RHEL_9_64', label: 'Red Hat Enterprise Linux 9 (64-bit)' },
    { id: 'RHEL_8_64', label: 'Red Hat Enterprise Linux 8 (64-bit)' },
    { id: 'CENTOS_7_64', label: 'CentOS 7 (64-bit)' },
    { id: 'CENTOS_64', label: 'CentOS 4/5/6 (64-bit)' },
    { id: 'FREEBSD_12_64', label: 'FreeBSD 12 (64-bit)' },
    { id: 'OTHER_3X_LINUX_64', label: 'Other Linux 3.x+ Kernel (64-bit)' },
    { id: 'OTHER_LINUX_64', label: 'Other Linux (64-bit)' }
  ] },
  { group: 'Windows', options: [
    { id: 'WINDOWS_SERVER_2025', label: 'Windows Server 2025 (64-bit)' },
    { id: 'WINDOWS_SERVER_2022', label: 'Windows Server 2022 (64-bit)' },
    { id: 'WINDOWS_SERVER_2019', label: 'Windows Server 2019 (64-bit)' },
    { id: 'WINDOWS_9_SERVER_64', label: 'Windows Server 2016 (64-bit)' },
    { id: 'WINDOWS_9_64', label: 'Windows 10 / 11 (64-bit)' },
    { id: 'WINDOWS_8_SERVER_64', label: 'Windows Server 2012 (64-bit)' }
  ] },
  { group: 'Khác', options: [
    { id: 'OTHER_64', label: 'Khác (64-bit)' },
    { id: 'OTHER', label: 'Khác (32-bit)' }
  ] }
];
function listGuestOsOptions() { return GUEST_OS_GROUPS; }

// Datastore ISO browser — used by the "empty VM" wizard's CD/DVD step so the user can pick an ISO
// already uploaded to a datastore instead of typing a raw datastore path by hand.
async function listDatastoreIsos(datastoreMoref) {
  const xml = await client.soap(`<vim25:RetrievePropertiesEx>
    <vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
    <vim25:specSet>
      <vim25:propSet><vim25:type>Datastore</vim25:type><vim25:pathSet>browser</vim25:pathSet><vim25:pathSet>name</vim25:pathSet></vim25:propSet>
      <vim25:objectSet><vim25:obj type="Datastore">${datastoreMoref}</vim25:obj></vim25:objectSet>
    </vim25:specSet>
    <vim25:options></vim25:options>
  </vim25:RetrievePropertiesEx>`);
  const browser = /<name>browser<\/name><val[^>]*>(.*?)<\/val>/.exec(xml)?.[1];
  const dsName = /<name>name<\/name><val[^>]*>(.*?)<\/val>/.exec(xml)?.[1];
  if (!browser || !dsName) return [];

  const taskXml = await client.soap(`<vim25:SearchDatastoreSubFolders_Task>
    <vim25:_this type="HostDatastoreBrowser">${browser}</vim25:_this>
    <vim25:datastorePath>[${client.escapeXml(dsName)}]</vim25:datastorePath>
    <vim25:searchSpec>
      <vim25:matchPattern>*.iso</vim25:matchPattern>
    </vim25:searchSpec>
  </vim25:SearchDatastoreSubFolders_Task>`);
  const taskMor = /<returnval type="Task">(.*?)<\/returnval>/.exec(taskXml)?.[1];
  if (!taskMor) return [];
  const { result } = await client.waitForTask(taskMor, { timeoutMs: 60000 });
  if (!result) return [];

  const isos = [];
  for (const block of result.match(/<HostDatastoreBrowserSearchResults.*?<\/HostDatastoreBrowserSearchResults>/gs) || []) {
    const folderPath = /<folderPath>(.*?)<\/folderPath>/.exec(block)?.[1];
    if (!folderPath) continue;
    const sep = folderPath.endsWith(']') ? ' ' : '';
    for (const fileBlock of block.match(/<file>.*?<\/file>/gs) || []) {
      const path = /<path>(.*?)<\/path>/.exec(fileBlock)?.[1];
      if (path) isos.push(`${folderPath}${sep}${path}`);
    }
  }
  return isos;
}

// Current CPU/RAM/disk of a VM or template — used to pre-fill the "Clone from template" form
// with its real defaults (REST works for this even though templates don't appear in the VM list).
async function getVmSpec(moref) {
  const [cpu, memory, disks, nics] = await Promise.all([
    client.rest('GET', `/api/vcenter/vm/${moref}/hardware/cpu`),
    client.rest('GET', `/api/vcenter/vm/${moref}/hardware/memory`),
    client.rest('GET', `/api/vcenter/vm/${moref}/hardware/disk`),
    client.rest('GET', `/api/vcenter/vm/${moref}/hardware/ethernet`)
  ]);
  const diskId = disks?.[0]?.disk || null;
  const diskDetail = diskId ? await client.rest('GET', `/api/vcenter/vm/${moref}/hardware/disk/${diskId}`) : null;
  const nicId = nics?.[0]?.nic || null;
  const nicDetail = nicId ? await client.rest('GET', `/api/vcenter/vm/${moref}/hardware/ethernet/${nicId}`) : null;
  return {
    cpuCount: cpu.count,
    memoryMib: memory.size_MiB,
    diskId,
    diskGb: diskDetail ? Math.round(diskDetail.capacity / 1073741824) : null,
    nicId,
    networkId: nicDetail?.backing?.network || null,
    networkName: nicDetail?.backing?.network_name || null
  };
}

async function setNetworkAdapter(moref, nicId, networkId) {
  await client.rest('PATCH', `/api/vcenter/vm/${moref}/hardware/ethernet/${nicId}`, {
    body: { backing: { type: 'STANDARD_PORTGROUP', network: networkId } }
  });
}

// Adds a brand-new disk/NIC to an already-existing VM — distinct from resizeDisk/setNetworkAdapter
// above, which only edit the template's own original disk/nic. Used by cloneVM to let the "Clone
// from template" form add extra disks/adapters beyond what the template itself has.
async function addDisk(moref, gb) {
  await client.rest('POST', `/api/vcenter/vm/${moref}/hardware/disk`, {
    body: { new_vmdk: { capacity: Math.round(gb * 1073741824) } }
  });
}

async function addNic(moref, networkId) {
  await client.rest('POST', `/api/vcenter/vm/${moref}/hardware/ethernet`, {
    body: { backing: { type: 'STANDARD_PORTGROUP', network: networkId }, start_connected: true }
  });
}

// REST has no way to resize a disk (verified: PATCH accepts an empty body but rejects any
// capacity-like field) — only SOAP ReconfigVM_Task supports it, and only with the disk's full
// controllerKey/unitNumber (a minimal {key, capacityInKB} edit fails with "MissingController").
async function getDiskDevice(moref, diskKey) {
  const xml = await client.soap(`<vim25:RetrievePropertiesEx>
    <vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
    <vim25:specSet>
      <vim25:propSet><vim25:type>VirtualMachine</vim25:type><vim25:pathSet>config.hardware.device</vim25:pathSet></vim25:propSet>
      <vim25:objectSet><vim25:obj type="VirtualMachine">${moref}</vim25:obj></vim25:objectSet>
    </vim25:specSet>
    <vim25:options></vim25:options>
  </vim25:RetrievePropertiesEx>`);
  for (const dev of xml.match(/<VirtualDevice xsi:type="VirtualDisk">.*?<\/VirtualDevice>/gs) || []) {
    const key = /^<VirtualDevice xsi:type="VirtualDisk"><key>(\d+)<\/key>/.exec(dev)?.[1];
    if (key !== String(diskKey)) continue;
    return {
      key,
      controllerKey: /<controllerKey>(\d+)<\/controllerKey>/.exec(dev)?.[1],
      unitNumber: /<unitNumber>(\d+)<\/unitNumber>/.exec(dev)?.[1],
      capacityInKB: Number(/<capacityInKB>(\d+)<\/capacityInKB>/.exec(dev)?.[1])
    };
  }
  return null;
}

async function resizeDisk(moref, diskId, newGb) {
  const device = await getDiskDevice(moref, diskId);
  if (!device) throw new Error(`Không tìm thấy ổ đĩa ${diskId} trên VM`);
  const newCapacityKB = newGb * 1024 * 1024;
  if (newCapacityKB <= device.capacityInKB) return; // only grow, never shrink

  const xml = await client.soap(`<vim25:ReconfigVM_Task>
    <vim25:_this type="VirtualMachine">${moref}</vim25:_this>
    <vim25:spec>
      <vim25:deviceChange>
        <vim25:operation>edit</vim25:operation>
        <vim25:device xsi:type="VirtualDisk">
          <vim25:key>${device.key}</vim25:key>
          <vim25:controllerKey>${device.controllerKey}</vim25:controllerKey>
          <vim25:unitNumber>${device.unitNumber}</vim25:unitNumber>
          <vim25:capacityInKB>${newCapacityKB}</vim25:capacityInKB>
        </vim25:device>
      </vim25:deviceChange>
    </vim25:spec>
  </vim25:ReconfigVM_Task>`);
  const taskMor = /<returnval type="Task">(.*?)<\/returnval>/.exec(xml)?.[1];
  if (!taskMor) throw new Error('Không lấy được Task từ ReconfigVM_Task');

  try {
    await client.waitForTask(taskMor);
  } catch (e) {
    // Observed on this vCenter: the task reports a "HostCommunication" fault from an unrelated
    // follow-up step even though the resize itself already applied. Trust the actual disk size,
    // not the task's reported outcome.
    const after = await client.rest('GET', `/api/vcenter/vm/${moref}/hardware/disk/${diskId}`);
    if (after.capacity < newCapacityKB * 1024) throw e;
  }
}

// Classic VM templates (config.template=true) don't appear in /api/vcenter/vm, so REST alone
// can't find them — only the SOAP PropertyCollector traversal sees them.
async function listTemplates() {
  const cviewXml = await client.soap(`<vim25:CreateContainerView>
    <vim25:_this type="ViewManager">ViewManager</vim25:_this>
    <vim25:container type="Folder">group-d1</vim25:container>
    <vim25:type>VirtualMachine</vim25:type>
    <vim25:recursive>true</vim25:recursive>
  </vim25:CreateContainerView>`);
  const cview = /<returnval type="ContainerView">(.*?)<\/returnval>/.exec(cviewXml)?.[1];
  if (!cview) return [];

  const xml = await client.soap(`<vim25:RetrievePropertiesEx>
    <vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
    <vim25:specSet>
      <vim25:propSet><vim25:type>VirtualMachine</vim25:type><vim25:pathSet>name</vim25:pathSet><vim25:pathSet>config.template</vim25:pathSet></vim25:propSet>
      <vim25:objectSet>
        <vim25:obj type="ContainerView">${cview}</vim25:obj>
        <vim25:skip>true</vim25:skip>
        <vim25:selectSet xsi:type="TraversalSpec">
          <vim25:name>traverseEntities</vim25:name>
          <vim25:type>ContainerView</vim25:type>
          <vim25:path>view</vim25:path>
          <vim25:skip>false</vim25:skip>
        </vim25:selectSet>
      </vim25:objectSet>
    </vim25:specSet>
    <vim25:options></vim25:options>
  </vim25:RetrievePropertiesEx>`);

  const templates = [];
  for (const o of xml.match(/<objects>(.*?)<\/objects>/gs) || []) {
    const isTemplate = /<name>config\.template<\/name><val[^>]*>true<\/val>/.test(o);
    if (!isTemplate) continue;
    const moref = /<obj type="VirtualMachine">(.*?)<\/obj>/.exec(o)?.[1];
    const name = /<name>name<\/name><val[^>]*>(.*?)<\/val>/.exec(o)?.[1];
    if (moref && name) templates.push({ moref, name });
  }
  return templates;
}

// ── Create ──
// disks/nics accept either the legacy singular diskGb/networkId (still used by older callers) or
// arrays (disks: [{gb}], nics: [{networkId}]) for the multi-disk/multi-NIC wizard. cdromIso is a
// full datastore path string (e.g. "[datastore1] ISO/ubuntu.iso") from listDatastoreIsos().
async function createEmptyVM({ name, guestOs = 'OTHER_LINUX_64', cpuCount = 2, memoryMib = 2048, diskGb, disks, networkId, nics, cdromIso, hostId, datastoreId, folderId }, user = null) {
  const diskList = disks && disks.length ? disks : (diskGb ? [{ gb: diskGb }] : [{ gb: 20 }]);
  const nicList = nics && nics.length ? nics : (networkId ? [{ networkId }] : []);
  const spec = {
    name,
    guest_OS: guestOs,
    placement: { folder: folderId, host: hostId, datastore: datastoreId },
    cpu: { count: cpuCount },
    memory: { size_MiB: memoryMib },
    disks: diskList.map(d => ({ new_vmdk: { capacity: Math.round(d.gb * 1073741824) } })),
    nics: nicList.map(n => ({ backing: { type: 'STANDARD_PORTGROUP', network: n.networkId } })),
    cdroms: cdromIso ? [{ start_connected: true, backing: { type: 'ISO_FILE', iso_file: cdromIso } }] : []
  };
  const vmId = await client.rest('POST', '/api/vcenter/vm', { body: spec });
  await logActivity(user, 'CREATE', 'vcenter_vm', null, name, `Tạo VM rỗng (${cpuCount} vCPU, ${memoryMib}MB RAM, ${diskList.length} disk, ${nicList.length} NIC${cdromIso ? ', CD/DVD gắn ISO' : ''})`);
  return { moref: vmId };
}

async function cloneVM({ templateMoref, name, hostId, datastoreId, poolId, folderId, powerOn = false, cpuCount, memoryMib, diskGb, networkId, extraDisks, extraNics }, user = null) {
  // Field order below must match vim-types.xsd exactly — VMware's SOAP parser is strict about it:
  // RelocateSpec: datastore, pool, host. CloneSpec: location, template, powerOn.
  // Always clone powered off — hardware edits below (esp. CPU) can fail on a running VM without
  // hot-add, and doing them before the caller's requested power-on keeps this safe either way.
  const xml = await client.soap(`<vim25:CloneVM_Task>
    <vim25:_this type="VirtualMachine">${templateMoref}</vim25:_this>
    <vim25:folder type="Folder">${folderId}</vim25:folder>
    <vim25:name>${client.escapeXml(name)}</vim25:name>
    <vim25:spec>
      <vim25:location>
        <vim25:datastore type="Datastore">${datastoreId}</vim25:datastore>
        ${poolId ? `<vim25:pool type="ResourcePool">${poolId}</vim25:pool>` : ''}
        <vim25:host type="HostSystem">${hostId}</vim25:host>
      </vim25:location>
      <vim25:template>false</vim25:template>
      <vim25:powerOn>false</vim25:powerOn>
    </vim25:spec>
  </vim25:CloneVM_Task>`);
  const taskMor = /<returnval type="Task">(.*?)<\/returnval>/.exec(xml)?.[1];
  if (!taskMor) throw new Error('Không lấy được Task từ CloneVM_Task');
  const { result } = await client.waitForTask(taskMor, { timeoutMs: 300000 });
  const newMoref = /type="VirtualMachine">(.*?)</.exec(result || '')?.[1] || result;
  await logActivity(user, 'CREATE', 'vcenter_vm', null, name, `Clone từ template (moref nguồn ${templateMoref})`);

  // Clamp CPU/RAM/disk to the template's own defaults — this form only offers to grow resources,
  // never shrink, so a stale/tampered request can't leave the clone under-provisioned relative to
  // its template. Network isn't a "grow" concept, so it's applied as given, no clamping.
  if (cpuCount != null || memoryMib != null || diskGb != null || networkId != null) {
    const base = await getVmSpec(newMoref);
    const cpu = cpuCount != null && cpuCount > base.cpuCount ? cpuCount : undefined;
    const mem = memoryMib != null && memoryMib > base.memoryMib ? memoryMib : undefined;
    if (cpu != null || mem != null) await updateHardware(newMoref, { cpuCount: cpu, memoryMib: mem }, user);
    if (diskGb != null && base.diskId) await resizeDisk(newMoref, base.diskId, diskGb);
    if (networkId != null && base.nicId) await setNetworkAdapter(newMoref, base.nicId, networkId);
  }
  // Extra disks/NICs beyond the template's own — added, never replacing what the template has.
  for (const d of extraDisks || []) await addDisk(newMoref, d.gb);
  for (const n of extraNics || []) await addNic(newMoref, n.networkId);
  if (extraDisks?.length || extraNics?.length) {
    await logActivity(user, 'UPDATE', 'vcenter_vm', null, name, `Thêm ${extraDisks?.length || 0} ổ đĩa, ${extraNics?.length || 0} network adapter sau khi clone`);
  }
  if (powerOn) await client.rest('POST', `/api/vcenter/vm/${newMoref}/power?action=start`);

  return { moref: newMoref };
}

// ── Power ──
const VALID_POWER_ACTIONS = ['start', 'stop', 'reset', 'suspend'];

async function powerAction(moref, action, user = null) {
  if (!VALID_POWER_ACTIONS.includes(action)) throw new Error(`Hành động không hợp lệ: ${action}`);
  await client.rest('POST', `/api/vcenter/vm/${moref}/power?action=${action}`);
  await logActivity(user, 'UPDATE', 'vcenter_vm', null, moref, `Power action: ${action}`);
}

// ── Edit hardware ──
async function updateHardware(moref, { cpuCount, memoryMib }, user = null) {
  if (cpuCount != null) await client.rest('PATCH', `/api/vcenter/vm/${moref}/hardware/cpu`, { body: { count: cpuCount } });
  if (memoryMib != null) await client.rest('PATCH', `/api/vcenter/vm/${moref}/hardware/memory`, { body: { size_MiB: memoryMib } });
  await logActivity(user, 'UPDATE', 'vcenter_vm', null, moref, `Sửa cấu hình: ${cpuCount != null ? `${cpuCount} vCPU ` : ''}${memoryMib != null ? `${memoryMib}MB RAM` : ''}`.trim());
}

async function renameVM(moref, newName, user = null) {
  const xml = await client.soap(`<vim25:Rename_Task>
    <vim25:_this type="VirtualMachine">${moref}</vim25:_this>
    <vim25:newName>${client.escapeXml(newName)}</vim25:newName>
  </vim25:Rename_Task>`);
  const taskMor = /<returnval type="Task">(.*?)<\/returnval>/.exec(xml)?.[1];
  if (!taskMor) throw new Error('Không lấy được Task từ Rename_Task');
  await client.waitForTask(taskMor);
  await logActivity(user, 'UPDATE', 'vcenter_vm', null, newName, `Đổi tên VM (moref ${moref})`);
}

// ── Delete ──
async function deleteVM(moref, user = null) {
  const vm = await db.prepare('SELECT name, power_state FROM vcenter_vms WHERE moref = ?').get(moref);
  if (vm?.power_state === 'POWERED_ON') {
    await client.rest('POST', `/api/vcenter/vm/${moref}/power?action=stop`);
  }
  await client.rest('DELETE', `/api/vcenter/vm/${moref}`);
  await db.prepare('DELETE FROM vcenter_vms WHERE moref = ?').run(moref);
  await logActivity(user, 'DELETE', 'vcenter_vm', null, vm?.name || moref, `Đã xóa VM (moref ${moref})`);
}

// ── Remote console ──
// WebMKS ticket: a short-lived credential the browser uses to open a direct WSS connection
// to the ESXi host running the VM (not through vCenter). Read-only to acquire; doesn't touch the VM.
async function getConsoleTicket(moref) {
  const result = await client.rest('POST', `/api/vcenter/vm/${moref}/console/tickets`, { body: { type: 'WEBMKS' } });
  if (!result?.ticket) throw new Error('vCenter không trả về ticket console');
  return { ticket: result.ticket };
}

module.exports = { listPlacement, listTemplates, createEmptyVM, cloneVM, powerAction, updateHardware, renameVM, deleteVM, getConsoleTicket, getVmSpec, resizeDisk, setNetworkAdapter, listGuestOsOptions, listDatastoreIsos };
