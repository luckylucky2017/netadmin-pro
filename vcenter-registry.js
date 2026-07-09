// Maps vcenter_clusters DB rows to live vcenter-client.js contexts, one per cluster, cached so
// each cluster's REST/SOAP session survives across calls instead of logging in every time.
const db = require('./database');
const vcenterClient = require('./vcenter-client');

const cache = new Map(); // clusterId -> { host, username, password, insecure, restToken, soapCookie }

async function getContext(clusterId) {
  if (cache.has(clusterId)) return cache.get(clusterId);
  const cluster = await db.prepare('SELECT * FROM vcenter_clusters WHERE id = ?').get(clusterId);
  if (!cluster) throw new Error('Không tìm thấy cụm vCenter');
  const context = {
    host: cluster.host, username: cluster.username, password: cluster.password,
    insecure: !!cluster.insecure, restToken: null, soapCookie: null
  };
  cache.set(clusterId, context);
  return context;
}

// Drops the cached session for a cluster — call after editing its host/username/password so the
// next call logs in fresh instead of reusing a session tied to the old credentials.
function invalidate(clusterId) {
  cache.delete(clusterId);
}

// Runs fn with the given cluster's client as "current" (see vcenter-client.js's run()).
// vcenter-actions.js / vcenter-collector.js need no changes — they just call client.rest()/soap()
// as before, and those calls resolve to whichever cluster's context this is currently inside.
async function withClient(clusterId, fn) {
  const context = await getContext(clusterId);
  return vcenterClient.run(context, fn);
}

async function getEnabledClusters() {
  return db.prepare('SELECT * FROM vcenter_clusters WHERE enabled = 1').all();
}

module.exports = { withClient, invalidate, getEnabledClusters };
