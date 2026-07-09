const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission } = require('../auth');

const VALID_METRICS = ['cpu', 'ram', 'disk'];
const VALID_OPERATORS = ['>', '>=', '<', '<='];
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const VALID_SCOPES = ['all', 'server', 'all_vms', 'vm'];

function normalizeScope(scope_type, scope_id) {
  const type = VALID_SCOPES.includes(scope_type) ? scope_type : 'all';
  const needsId = type === 'server' || type === 'vm';
  return { scope_type: type, scope_id: needsId ? scope_id : null };
}

router.get('/', async (req, res) => {
  const rules = await db.prepare(`
    SELECT r.*,
      CASE WHEN r.scope_type = 'server' THEN s.name WHEN r.scope_type = 'vm' THEN v.name END as scope_name
    FROM alert_rules r
    LEFT JOIN servers s ON r.scope_type = 'server' AND r.scope_id = s.id
    LEFT JOIN vcenter_vms v ON r.scope_type = 'vm' AND r.scope_id = v.id
    ORDER BY r.created_at DESC
  `).all();
  res.json(rules);
});

router.post('/', requirePermission('rules.write'), async (req, res) => {
  const { name, metric, operator, threshold, duration_sec, severity } = req.body;
  if (!name || !metric || !operator || threshold == null) return res.status(400).json({ error: 'Thiếu tên, metric, operator hoặc threshold' });
  if (!VALID_METRICS.includes(metric)) return res.status(400).json({ error: 'Metric không hợp lệ' });
  if (!VALID_OPERATORS.includes(operator)) return res.status(400).json({ error: 'Operator không hợp lệ' });
  if (!VALID_SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Severity không hợp lệ' });
  const scope = normalizeScope(req.body.scope_type, req.body.scope_id);

  const result = await db.prepare(`
    INSERT INTO alert_rules (name, scope_type, scope_id, metric, operator, threshold, duration_sec, severity, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'resource')
  `).run(name, scope.scope_type, scope.scope_id, metric, operator, threshold, duration_sec || 60, severity);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Rule created' });
});

router.put('/:id', requirePermission('rules.write'), async (req, res) => {
  const rule = await db.prepare('SELECT id FROM alert_rules WHERE id=?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  const { name, metric, operator, threshold, duration_sec, severity } = req.body;
  if (!VALID_METRICS.includes(metric)) return res.status(400).json({ error: 'Metric không hợp lệ' });
  if (!VALID_OPERATORS.includes(operator)) return res.status(400).json({ error: 'Operator không hợp lệ' });
  if (!VALID_SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Severity không hợp lệ' });
  const scope = normalizeScope(req.body.scope_type, req.body.scope_id);

  await db.prepare(`
    UPDATE alert_rules SET name=?, scope_type=?, scope_id=?, metric=?, operator=?, threshold=?, duration_sec=?, severity=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(name, scope.scope_type, scope.scope_id, metric, operator, threshold, duration_sec || 60, severity, req.params.id);
  res.json({ message: 'Updated' });
});

router.post('/:id/toggle', requirePermission('rules.write'), async (req, res) => {
  const rule = await db.prepare('SELECT * FROM alert_rules WHERE id=?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE alert_rules SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(rule.enabled ? 0 : 1, req.params.id);
  res.json({ enabled: rule.enabled ? 0 : 1 });
});

router.delete('/:id', requirePermission('rules.delete'), async (req, res) => {
  const rule = await db.prepare('SELECT id FROM alert_rules WHERE id=?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM alert_rules WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
