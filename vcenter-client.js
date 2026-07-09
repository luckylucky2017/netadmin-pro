// Shared vCenter client: REST (vSphere Automation API) session + SOAP (VIM API) session.
// Used by vcenter-collector.js (read-only sync) and vcenter-actions.js (create/edit/delete/power).
//
// Multi-vCenter support: this used to hold ONE connection's state in module-level variables
// (VCENTER_HOST/restToken/soapCookie read once from .env at startup). Now each vCenter cluster
// needs its own independent session, so connection state lives in a per-cluster context object
// threaded through AsyncLocalStorage instead — same pattern database.js already uses for
// db.transaction()'s per-call connection. vcenter-registry.js owns creating/caching these context
// objects (one per cluster, reused across calls so sessions still don't re-login every request) and
// calls run(ctx, fn) to make it the "current" client for the duration of fn. vcenter-actions.js and
// vcenter-collector.js are UNCHANGED — they still just call rest()/soap() with no cluster awareness,
// as long as they're invoked from inside a run() call.
const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');

const clientContext = new AsyncLocalStorage();

function ctx() {
  const c = clientContext.getStore();
  if (!c) throw new Error('vCenter client chưa được thiết lập ngữ cảnh — phải gọi qua vcenter-registry.withClient()');
  return c;
}

// Runs fn with `context` (shape: { host, username, password, insecure, restToken, soapCookie })
// as the active client for the duration of fn (and anything it awaits/calls). `context` is mutated
// in place as sessions are established, so passing the SAME object back in on a later call picks up
// the cached restToken/soapCookie rather than logging in again.
function run(context, fn) {
  return clientContext.run(context, fn);
}

function configured() {
  const c = clientContext.getStore();
  return !!(c && c.host && c.username && c.password);
}

// ── REST (vSphere Automation API) ──

function restRequest(method, urlPath, { body } = {}) {
  const c = ctx();
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: c.host, port: 443, path: urlPath, method,
      rejectUnauthorized: !c.insecure,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(c.restToken ? { 'vmware-api-session-id': c.restToken } : {})
      }
    }, res => {
      let chunks = '';
      res.on('data', d => { chunks += d; });
      res.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = chunks; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(Object.assign(new Error(`vCenter REST ${method} ${urlPath} -> ${res.statusCode}: ${JSON.stringify(parsed)}`), { statusCode: res.statusCode, body: parsed }));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function restLogin() {
  const c = ctx();
  const basic = Buffer.from(`${c.username}:${c.password}`).toString('base64');
  c.restToken = await new Promise((resolve, reject) => {
    const req = https.request({
      host: c.host, port: 443, path: '/api/session', method: 'POST',
      rejectUnauthorized: !c.insecure,
      headers: { Authorization: `Basic ${basic}` }
    }, res => {
      let chunks = '';
      res.on('data', d => { chunks += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); } }
        else reject(Object.assign(new Error(`vCenter đăng nhập thất bại (${res.statusCode}): ${chunks}`), { statusCode: res.statusCode }));
      });
    });
    req.on('error', reject);
    req.end();
  });
  return c.restToken;
}

async function rest(method, urlPath, opts = {}, allowRetry = true) {
  const c = ctx();
  if (!c.restToken) await restLogin();
  try {
    return await restRequest(method, urlPath, opts);
  } catch (e) {
    if (e.statusCode === 401 && allowRetry) { c.restToken = null; return rest(method, urlPath, opts, false); }
    throw e;
  }
}

// ── SOAP (VIM API) ──

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function soapCall(bodyXml) {
  const c = ctx();
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vim25="urn:vim25" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${bodyXml}</soapenv:Body></soapenv:Envelope>`;
    const req = https.request({
      host: c.host, port: 443, path: '/sdk', method: 'POST',
      rejectUnauthorized: !c.insecure,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(xml),
        // Without SOAPAction, vCenter falls back to an ancient default schema that predates
        // RetrievePropertiesEx/QueryPerf/CloneVM_Task. vim25/6.7 is old enough to be broadly
        // compatible but modern enough to support everything this module calls.
        SOAPAction: 'urn:vim25/6.7',
        ...(c.soapCookie ? { Cookie: c.soapCookie } : {})
      }
    }, res => {
      let chunks = '';
      res.on('data', d => { chunks += d; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie && setCookie.length) c.soapCookie = setCookie[0].split(';')[0];
        if (chunks.includes('<soapenv:Fault>')) {
          const msg = /<faultstring>(.*?)<\/faultstring>/s.exec(chunks);
          reject(new Error(`vCenter SOAP fault: ${msg ? msg[1].trim() : 'unknown'}`));
        } else resolve(chunks);
      });
    });
    req.on('error', reject);
    req.write(xml);
    req.end();
  });
}

async function soapLogin() {
  const c = ctx();
  c.soapCookie = null;
  await soapCall(`<vim25:Login>
    <vim25:_this type="SessionManager">SessionManager</vim25:_this>
    <vim25:userName>${escapeXml(c.username)}</vim25:userName>
    <vim25:password>${escapeXml(c.password)}</vim25:password>
  </vim25:Login>`);
}

async function soap(bodyXml, allowRetry = true) {
  const c = ctx();
  if (!c.soapCookie) await soapLogin();
  try {
    return await soapCall(bodyXml);
  } catch (e) {
    if (allowRetry && /NotAuthenticated/i.test(e.message)) { c.soapCookie = null; return soap(bodyXml, false); }
    throw e;
  }
}

async function waitForTask(taskMor, { timeoutMs = 180000, pollMs = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const xml = await soap(`<vim25:RetrievePropertiesEx>
      <vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
      <vim25:specSet>
        <vim25:propSet><vim25:type>Task</vim25:type><vim25:pathSet>info.state</vim25:pathSet><vim25:pathSet>info.error</vim25:pathSet><vim25:pathSet>info.result</vim25:pathSet></vim25:propSet>
        <vim25:objectSet><vim25:obj type="Task">${taskMor}</vim25:obj></vim25:objectSet>
      </vim25:specSet>
      <vim25:options></vim25:options>
    </vim25:RetrievePropertiesEx>`);
    const state = /<name>info\.state<\/name><val[^>]*>(\w+)<\/val>/.exec(xml)?.[1];
    if (state === 'success') {
      const result = /<name>info\.result<\/name><val[^>]*>(.*?)<\/val>/s.exec(xml)?.[1];
      return { state, result };
    }
    if (state === 'error') {
      const msg = /<localizedMessage>(.*?)<\/localizedMessage>/s.exec(xml)?.[1] || 'Task failed';
      throw new Error(msg);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Task timed out');
}

module.exports = { run, configured, rest, soap, escapeXml, waitForTask };
