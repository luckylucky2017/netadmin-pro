// Shared vCenter client: REST (vSphere Automation API) session + SOAP (VIM API) session.
// Used by vcenter-collector.js (read-only sync) and vcenter-actions.js (create/edit/delete/power).
const https = require('https');

const VCENTER_HOST = process.env.VCENTER_HOST;
const VCENTER_USER = process.env.VCENTER_USER;
const VCENTER_PASSWORD = process.env.VCENTER_PASSWORD;
const VCENTER_INSECURE = process.env.VCENTER_INSECURE !== 'false'; // vCenter's cert is self-signed by default

function configured() {
  return !!(VCENTER_HOST && VCENTER_USER && VCENTER_PASSWORD);
}

// ── REST (vSphere Automation API) ──
let restToken = null;

function restRequest(method, urlPath, { body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: VCENTER_HOST, port: 443, path: urlPath, method,
      rejectUnauthorized: !VCENTER_INSECURE,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(restToken ? { 'vmware-api-session-id': restToken } : {})
      }
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
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
  const basic = Buffer.from(`${VCENTER_USER}:${VCENTER_PASSWORD}`).toString('base64');
  restToken = await new Promise((resolve, reject) => {
    const req = https.request({
      host: VCENTER_HOST, port: 443, path: '/api/session', method: 'POST',
      rejectUnauthorized: !VCENTER_INSECURE,
      headers: { Authorization: `Basic ${basic}` }
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
  return restToken;
}

async function rest(method, urlPath, opts = {}, allowRetry = true) {
  if (!restToken) await restLogin();
  try {
    return await restRequest(method, urlPath, opts);
  } catch (e) {
    if (e.statusCode === 401 && allowRetry) { restToken = null; return rest(method, urlPath, opts, false); }
    throw e;
  }
}

// ── SOAP (VIM API) ──
let soapCookie = null;

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function soapCall(bodyXml) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vim25="urn:vim25" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${bodyXml}</soapenv:Body></soapenv:Envelope>`;
    const req = https.request({
      host: VCENTER_HOST, port: 443, path: '/sdk', method: 'POST',
      rejectUnauthorized: !VCENTER_INSECURE,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(xml),
        // Without SOAPAction, vCenter falls back to an ancient default schema that predates
        // RetrievePropertiesEx/QueryPerf/CloneVM_Task. vim25/6.7 is old enough to be broadly
        // compatible but modern enough to support everything this module calls.
        SOAPAction: 'urn:vim25/6.7',
        ...(soapCookie ? { Cookie: soapCookie } : {})
      }
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie && setCookie.length) soapCookie = setCookie[0].split(';')[0];
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
  soapCookie = null;
  await soapCall(`<vim25:Login>
    <vim25:_this type="SessionManager">SessionManager</vim25:_this>
    <vim25:userName>${escapeXml(VCENTER_USER)}</vim25:userName>
    <vim25:password>${escapeXml(VCENTER_PASSWORD)}</vim25:password>
  </vim25:Login>`);
}

async function soap(bodyXml, allowRetry = true) {
  if (!soapCookie) await soapLogin();
  try {
    return await soapCall(bodyXml);
  } catch (e) {
    if (allowRetry && /NotAuthenticated/i.test(e.message)) { soapCookie = null; return soap(bodyXml, false); }
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

module.exports = { configured, rest, soap, escapeXml, waitForTask };
