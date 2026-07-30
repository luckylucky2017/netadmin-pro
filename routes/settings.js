const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const settings = require('../settings');
const notify = require('../notification-dispatcher');

// anthropic_api_key/ldap_bind_password/saml_idp_cert/telegram_bot_token/smtp_password are
// credentials — never returned to the client, same treatment as
// ssh_credentials.password/vcenter_clusters.password. has_* booleans let the UI show "already set"
// (••••••••) without ever round-tripping the real secret.
function sanitizeSettings(s) {
  if (!s) return s;
  const { anthropic_api_key, ldap_bind_password, saml_idp_cert, telegram_bot_token, smtp_password, ...rest } = s;
  return {
    ...rest,
    has_anthropic_api_key: !!anthropic_api_key,
    has_ldap_bind_password: !!ldap_bind_password,
    has_saml_cert: !!saml_idp_cert,
    has_telegram_bot_token: !!telegram_bot_token,
    has_smtp_password: !!smtp_password,
  };
}

router.get('/', requirePermission('settings.manage'), async (req, res) => {
  res.json(sanitizeSettings(await settings.getSettings()));
});

router.put('/', requirePermission('settings.manage'), async (req, res) => {
  const {
    anthropic_api_key, saml_idp_entry_point, saml_idp_cert, saml_sp_entity_id, saml_sp_callback_url,
    ldap_url, ldap_bind_dn, ldap_bind_password, ldap_base_dn, ldap_user_filter,
    telegram_bot_token, telegram_chat_id,
    smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, smtp_from, smtp_to,
  } = req.body;
  // Blank secret fields = keep existing — same COALESCE/NULLIF pattern routes/servers.js uses for
  // ipmi_password, so the settings form never needs to round-trip the real secrets.
  await db.prepare(`
    UPDATE app_settings SET
      anthropic_api_key = COALESCE(NULLIF(?, ''), anthropic_api_key),
      saml_idp_entry_point = ?,
      saml_idp_cert = COALESCE(NULLIF(?, ''), saml_idp_cert),
      saml_sp_entity_id = ?,
      saml_sp_callback_url = ?,
      ldap_url = ?,
      ldap_bind_dn = ?,
      ldap_bind_password = COALESCE(NULLIF(?, ''), ldap_bind_password),
      ldap_base_dn = ?,
      ldap_user_filter = ?,
      telegram_bot_token = COALESCE(NULLIF(?, ''), telegram_bot_token),
      telegram_chat_id = ?,
      smtp_host = ?,
      smtp_port = ?,
      smtp_secure = ?,
      smtp_user = ?,
      smtp_password = COALESCE(NULLIF(?, ''), smtp_password),
      smtp_from = ?,
      smtp_to = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(
    anthropic_api_key || '', saml_idp_entry_point || null, saml_idp_cert || '',
    saml_sp_entity_id || 'netadmin-pro', saml_sp_callback_url || null,
    ldap_url || null, ldap_bind_dn || null, ldap_bind_password || '',
    ldap_base_dn || null, ldap_user_filter || '(sAMAccountName={{username}})',
    telegram_bot_token || '', telegram_chat_id || null,
    smtp_host || null, Number(smtp_port) || 587, smtp_secure ? 1 : 0, smtp_user || null,
    smtp_password || '', smtp_from || null, smtp_to || null
  );
  settings.invalidate();
  await logActivity(req.user, 'UPDATE', 'app_settings', 1, 'Cài đặt hệ thống');
  res.json({ message: 'Đã lưu cài đặt' });
});

// Both test-send routes always use the SAVED config in the DB (never the unsaved form state) — so
// "Gửi thử" only ever tests what Save actually persisted, avoiding any need to pass a raw secret
// through this endpoint from a form that might still have the masked placeholder in it.
router.post('/test-telegram', requirePermission('settings.manage'), async (req, res) => {
  const s = await db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
  if (!s?.telegram_bot_token || !s?.telegram_chat_id) {
    return res.status(400).json({ error: 'Chưa cấu hình Bot Token / Chat ID — lưu cài đặt trước khi gửi thử' });
  }
  try {
    await notify.sendTelegram(s, { title: 'Tin nhắn thử', message: 'Đây là tin nhắn thử từ NetAdmin Pro.', severity: 'info', source_name: null, created_at: new Date() });
    res.json({ message: 'Đã gửi tin nhắn thử qua Telegram' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/test-smtp', requirePermission('settings.manage'), async (req, res) => {
  const s = await db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
  if (!s?.smtp_host || !s?.smtp_to) {
    return res.status(400).json({ error: 'Chưa cấu hình SMTP Host / người nhận — lưu cài đặt trước khi gửi thử' });
  }
  try {
    await notify.sendSmtp(s, { title: 'Email thử', message: 'Đây là email thử từ NetAdmin Pro.', severity: 'info', source_name: null, created_at: new Date() });
    res.json({ message: 'Đã gửi email thử qua SMTP' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
