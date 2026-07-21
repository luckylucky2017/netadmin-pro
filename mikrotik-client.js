// Thin wrapper around node-routeros's RouterOSAPI (the legacy binary API protocol RouterOS v6.x
// speaks on port 8728/8729 — there is no REST/HTTP API at all before RouterOS v7.1). Every caller
// goes through withConnection() so a connection is always opened fresh, used for exactly one
// request/collection cycle, and closed — mirrors pfsense-client.js's per-call request() shape
// closely enough that mikrotik-collector.js/routes/mikrotik.js read the same way, but this
// protocol has no persistent-session/cookie concept to reuse across calls the way pfSense's REST
// API does, so there's no connection-pooling equivalent to build here.
const { RouterOSAPI } = require('node-routeros');
const { Client: FtpClient } = require('basic-ftp');
const { Writable } = require('stream');
const crypto = require('crypto');

const CONNECT_TIMEOUT_SEC = 10;

async function withConnection(fw, fn) {
  const conn = new RouterOSAPI({
    host: fw.host,
    user: fw.username,
    password: fw.password || '',
    port: fw.port || 8728,
    timeout: CONNECT_TIMEOUT_SEC,
  });
  try {
    await conn.connect();
    return await fn(conn);
  } finally {
    try { await conn.close(); } catch { /* already closed/never fully opened — nothing to clean up */ }
  }
}

async function testConnection(fw) {
  try {
    const identity = await withConnection(fw, (conn) => conn.write('/system/identity/print'));
    return { ok: true, identity: identity[0]?.name || null };
  } catch (e) {
    return { ok: false, error: e.message || 'Không kết nối được tới MikroTik' };
  }
}

// RouterOS's API has no way to stream a file's raw bytes back — /file/print only gives name/size/
// type metadata. FTP (already required to be reachable for syncOpenvpnCerts below) is the only way
// to actually retrieve an exported certificate/key's content.
async function fetchFileViaFtp(fw, filename) {
  const ftp = new FtpClient(15000);
  try {
    await ftp.access({ host: fw.host, user: fw.username, password: fw.password || '', secure: false });
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    await ftp.downloadTo(sink, filename);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    ftp.close();
  }
}

// Fetches the shared CA + "Client" certificate (public cert + private key) already used by the
// router's 39 existing OpenVPN users (confirmed against the real router — see mikrotik-collector.js
// header comment / database.js's mikrotik_firewalls.ovpn_* column comment for the full reasoning).
// RouterOS only exports a certificate's PRIVATE KEY when given a non-empty export-passphrase — so a
// random one-time passphrase is used, the key is decrypted locally right after download, and the
// exported files are removed from the router's filesystem again immediately (a private key sitting
// in router storage indefinitely, even encrypted, is unnecessary exposure once we have the PEM).
async function syncOpenvpnCerts(fw) {
  const passphrase = crypto.randomBytes(24).toString('hex');
  const caFile = 'na_ovpn_ca';
  const clientFile = 'na_ovpn_client';
  await withConnection(fw, async (conn) => {
    await conn.write('/certificate/export-certificate', ['=.id=CA', `=file-name=${caFile}`]);
    await conn.write('/certificate/export-certificate', ['=.id=Client', `=export-passphrase=${passphrase}`, `=file-name=${clientFile}`]);
  });
  let caCert, clientCert, clientKeyEnc;
  try {
    caCert = await fetchFileViaFtp(fw, `${caFile}.crt`);
    clientCert = await fetchFileViaFtp(fw, `${clientFile}.crt`);
    clientKeyEnc = await fetchFileViaFtp(fw, `${clientFile}.key`);
  } finally {
    // Always clean up, even if one of the FTP fetches failed partway through.
    await withConnection(fw, async (conn) => {
      const files = await conn.write('/file/print');
      for (const f of files) {
        if (f.name === `${caFile}.crt` || f.name === `${clientFile}.crt` || f.name === `${clientFile}.key`) {
          await conn.write('/file/remove', [`=.id=${f['.id']}`]).catch(() => {});
        }
      }
    }).catch(() => {});
  }
  const clientKey = crypto.createPrivateKey({ key: clientKeyEnc, passphrase, format: 'pem' })
    .export({ type: 'pkcs8', format: 'pem' }).toString();
  return { caCert, clientCert, clientKey };
}

module.exports = { withConnection, testConnection, fetchFileViaFtp, syncOpenvpnCerts };
