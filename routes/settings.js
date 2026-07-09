const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const settings = require('../settings');

// anthropic_api_key/ldap_bind_password/saml_idp_cert are credentials — never returned to the
// client, same treatment as ssh_credentials.password/vcenter_clusters.password. has_* booleans
// let the UI show "already set" (••••••••) without ever round-tripping the real secret.
function sanitizeSettings(s) {
  if (!s) return s;
  const { anthropic_api_key, ldap_bind_password, saml_idp_cert, ...rest } = s;
  return {
    ...rest,
    has_anthropic_api_key: !!anthropic_api_key,
    has_ldap_bind_password: !!ldap_bind_password,
    has_saml_cert: !!saml_idp_cert,
  };
}

router.get('/', requirePermission('settings.manage'), async (req, res) => {
  res.json(sanitizeSettings(await settings.getSettings()));
});

router.put('/', requirePermission('settings.manage'), async (req, res) => {
  const {
    anthropic_api_key, saml_idp_entry_point, saml_idp_cert, saml_sp_entity_id, saml_sp_callback_url,
    ldap_url, ldap_bind_dn, ldap_bind_password, ldap_base_dn, ldap_user_filter
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
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(
    anthropic_api_key || '', saml_idp_entry_point || null, saml_idp_cert || '',
    saml_sp_entity_id || 'netadmin-pro', saml_sp_callback_url || null,
    ldap_url || null, ldap_bind_dn || null, ldap_bind_password || '',
    ldap_base_dn || null, ldap_user_filter || '(sAMAccountName={{username}})'
  );
  settings.invalidate();
  await logActivity(req.user, 'UPDATE', 'app_settings', 1, 'Cài đặt hệ thống');
  res.json({ message: 'Đã lưu cài đặt' });
});

module.exports = router;
