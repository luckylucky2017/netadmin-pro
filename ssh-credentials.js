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

// Ad-hoc test — credential doesn't need to be attached to any server/VM row yet (used by the
// "Kiểm tra kết nối" button when adding/editing a credential in the UI). Opens and immediately
// closes a real SSH connection; throws on failure (caller — the route handler — turns that into
// {ok:false, message}, same pattern as vCenter cluster connection testing).
async function testConnection({ credentialId, host, port }) {
  const cred = await getCredential(credentialId);
  if (!cred) throw new Error('Không tìm thấy tài khoản kết nối');
  if (!host) throw new Error('Thiếu host để kiểm tra');
  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  const opts = { host, port: port || 22, username: cred.username, readyTimeout: 8000 };
  if (cred.auth_type === 'password') opts.password = cred.password;
  else { opts.privateKey = cred.private_key; opts.passphrase = cred.passphrase || undefined; }
  await ssh.connect(opts);
  ssh.dispose();
  return { ok: true, message: `Kết nối SSH thành công tới ${host}:${opts.port} với user "${cred.username}"` };
}

module.exports = { getCredential, buildConnectOptions, testConnection };
