const express = require('express');
const router = express.Router();
const db = require('../database');
const collector = require('../vcenter-collector');
const actions = require('../vcenter-actions');
const { requirePermission } = require('../auth');

router.get('/vms', async (req, res) => {
  const { search, power_state } = req.query;
  let query = 'SELECT * FROM vcenter_vms WHERE 1=1';
  const params = [];
  if (search) { query += ' AND name LIKE ?'; params.push(`%${search}%`); }
  if (power_state) { query += ' AND power_state = ?'; params.push(power_state); }
  // Critical (any metric >=90%) first, then high (>=70%), so VMs under real resource pressure
  // surface at the top instead of being buried alphabetically among 100+ healthy VMs.
  query += `
    ORDER BY
      CASE WHEN cpu_pct >= 90 OR mem_pct >= 90 OR disk_pct >= 90 THEN 0
           WHEN cpu_pct >= 70 OR mem_pct >= 70 OR disk_pct >= 70 THEN 1
           ELSE 2 END,
      name ASC
  `;
  res.json(await db.prepare(query).all(...params));
});

router.get('/stats', async (req, res) => {
  const total = (await db.prepare('SELECT COUNT(*) as cnt FROM vcenter_vms').get()).cnt;
  const on = (await db.prepare("SELECT COUNT(*) as cnt FROM vcenter_vms WHERE power_state='POWERED_ON'").get()).cnt;
  const off = (await db.prepare("SELECT COUNT(*) as cnt FROM vcenter_vms WHERE power_state='POWERED_OFF'").get()).cnt;
  const lastSync = (await db.prepare('SELECT MAX(last_synced_at) as t FROM vcenter_vms').get()).t;
  res.json({ total, on, off, unknown: total - on - off, lastSync, configured: !!(process.env.VCENTER_HOST && process.env.VCENTER_USER) });
});

router.post('/sync', requirePermission('vcenter.sync'), async (req, res) => {
  try {
    const r = await collector.syncVMs();
    res.json({ message: 'Đã đồng bộ', ...r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/placement', async (req, res) => {
  try { res.json(await actions.listPlacement()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/templates', async (req, res) => {
  try { res.json(await actions.listTemplates()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/templates/:moref/spec', async (req, res) => {
  try { res.json(await actions.getVmSpec(req.params.moref)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/guest-os', (req, res) => {
  res.json(actions.listGuestOsOptions());
});

router.get('/datastore/:moref/isos', async (req, res) => {
  try { res.json(await actions.listDatastoreIsos(req.params.moref)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/vms', requirePermission('vcenter.vm.create'), async (req, res) => {
  const b = req.body;
  try {
    let result;
    if (b.mode === 'clone') {
      if (!b.templateMoref || !b.name || !b.hostId || !b.datastoreId || !b.folderId) {
        return res.status(400).json({ error: 'Thiếu templateMoref/name/hostId/datastoreId/folderId' });
      }
      result = await actions.cloneVM(b, req.user);
    } else {
      if (!b.name || !b.hostId || !b.datastoreId || !b.folderId) {
        return res.status(400).json({ error: 'Thiếu name/hostId/datastoreId/folderId' });
      }
      result = await actions.createEmptyVM(b, req.user);
    }
    await collector.syncVMs();
    res.status(201).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/vms/:moref/console', requirePermission('vcenter.vm.console'), async (req, res) => {
  try {
    res.json(await actions.getConsoleTicket(req.params.moref));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/vms/:moref/power', requirePermission('vcenter.vm.power'), async (req, res) => {
  try {
    await actions.powerAction(req.params.moref, req.body.action, req.user);
    await collector.syncVMs();
    res.json({ message: 'OK' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.patch('/vms/:moref/hardware', requirePermission('vcenter.vm.edit'), async (req, res) => {
  try {
    await actions.updateHardware(req.params.moref, req.body, req.user);
    await collector.syncVMs();
    res.json({ message: 'OK' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.patch('/vms/:moref/rename', requirePermission('vcenter.vm.edit'), async (req, res) => {
  try {
    await actions.renameVM(req.params.moref, req.body.name, req.user);
    await collector.syncVMs();
    res.json({ message: 'OK' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.delete('/vms/:moref', requirePermission('vcenter.vm.delete'), async (req, res) => {
  const vm = await db.prepare('SELECT name FROM vcenter_vms WHERE moref = ?').get(req.params.moref);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  if (req.body?.confirmName !== vm.name) {
    return res.status(400).json({ error: 'Tên xác nhận không khớp' });
  }
  try {
    await actions.deleteVM(req.params.moref, req.user);
    res.json({ message: 'Đã xóa' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
