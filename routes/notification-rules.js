const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');

// Rows are seeded once in database.js's ensureSchemaAndMigrations (INSERT IGNORE) — this route only
// ever reads/updates the existing 14 rows, never creates or deletes any (the type catalog is
// code-defined, not admin-editable, since each type_key must match a real alerts.metric value).
router.get('/', requirePermission('settings.manage'), async (req, res) => {
  res.json(await db.prepare('SELECT * FROM notification_rules ORDER BY label ASC').all());
});

router.put('/', requirePermission('settings.manage'), async (req, res) => {
  const rows = Array.isArray(req.body?.rules) ? req.body.rules : [];
  for (const r of rows) {
    if (!r?.type_key) continue;
    await db.prepare('UPDATE notification_rules SET telegram_enabled = ?, smtp_enabled = ? WHERE type_key = ?')
      .run(r.telegram_enabled ? 1 : 0, r.smtp_enabled ? 1 : 0, r.type_key);
  }
  await logActivity(req.user, 'UPDATE', 'notification_rules', 0, 'Cấu hình loại cảnh báo gửi thông báo');
  res.json({ message: 'Đã lưu cấu hình loại cảnh báo' });
});

module.exports = router;
