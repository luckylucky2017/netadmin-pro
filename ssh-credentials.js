// Shared SSH connection-credential resolution — replaces the old model where every collector read
// ONE global private key from SSH_PRIVATE_KEY_PATH/.env. Now each server/VM row references a
// ssh_credentials.id (row.ssh_credential_id); this module turns that into node-ssh .connect()
// options. Used by ssh-collector.js, fail2ban-manager.js, fail2ban-collector.js,
// outbound-connection-collector.js, ssh-security-collector.js — all previously duplicated the same
// KEY_PATH/connect-options logic independently.
const db = require('./database');

async function getCredential(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM ssh_credentials WHERE id = ?').get(id);
}

// row must have ip_address, ssh_port, ssh_credential_id (servers or vcenter_vms rows both fit).
// Returns null if no credential is assigned — same "skip, don't monitor" behavior every collector
// already had for a blank ssh_user, now driven by ssh_credential_id instead.
async function buildConnectOptions(row) {
  if (!row.ssh_credential_id) return null;
  const cred = await getCredential(row.ssh_credential_id);
  if (!cred) return null;
  const base = { host: row.ip_address, port: row.ssh_port || 22, username: cred.username, readyTimeout: 8000 };
  if (cred.auth_type === 'password') {
    return { ...base, password: cred.password };
  }
  return { ...base, privateKey: cred.private_key, passphrase: cred.passphrase || undefined };
}

// Ad-hoc test — used by the "Kiểm tra kết nối" button when adding/editing a credential in the UI.
// Tests whatever is CURRENTLY TYPED in the form, not stale already-saved values: credentialId is
// optional (omitted entirely for a brand-new, not-yet-saved credential); when given (editing an
// existing one), blank private_key/passphrase/password fall back to what's already saved — same
// "blank = keep existing" merge routes/ssh-credentials.js's PUT uses, so the test reflects exactly
// what clicking "Lưu thay đổi" would actually persist, without requiring a save first. Opens and
// immediately closes a real SSH connection; throws on failure (caller — the route handler — turns
// that into {ok:false, message}, same pattern as vCenter cluster connection testing).
async function testConnection({ credentialId, host, port, auth_type, username, private_key, passphrase, password }) {
  if (!host) throw new Error('Thiếu host để kiểm tra');
  const cred = credentialId ? await getCredential(credentialId) : null;
  if (credentialId && !cred) throw new Error('Không tìm thấy tài khoản kết nối');
  const effective = {
    auth_type: auth_type || cred?.auth_type || 'private_key',
    username: username || cred?.username,
    private_key: private_key || cred?.private_key,
    passphrase: passphrase || cred?.passphrase,
    password: password || cred?.password,
  };
  if (!effective.username) throw new Error('Thiếu username');
  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  const opts = { host, port: port || 22, username: effective.username, readyTimeout: 8000 };
  if (effective.auth_type === 'password') {
    if (!effective.password) throw new Error('Thiếu mật khẩu');
    opts.password = effective.password;
  } else {
    if (!effective.private_key) throw new Error('Thiếu private key');
    opts.privateKey = effective.private_key;
    opts.passphrase = effective.passphrase || undefined;
  }
  await ssh.connect(opts);
  ssh.dispose();
  return { ok: true, message: `Kết nối SSH thành công tới ${host}:${opts.port} với user "${effective.username}"` };
}

module.exports = { getCredential, buildConnectOptions, testConnection };
