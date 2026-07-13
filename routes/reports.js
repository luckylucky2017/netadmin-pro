// Aggregated "foreign connections" security report — combines 3 already-tracked signals into one
// view: SSH (sshd jail) blocks, WAF (netadmin-waf jail) blocks, and outbound connections FROM our
// VMs TO foreign destinations. Purely a read-only rollup of data already visible on the Alerts/
// Giám sát bất thường/Giám sát WAF pages — no new detection logic, no new permission (ungated
// beyond requireAuth, matching every other read-only GET in this app).
const express = require('express');
const router = express.Router();
const db = require('../database');
const { classifyIp } = require('../ssh-security-collector');

const MAX_DAYS = 90;

// MySQL's time_zone=SYSTEM on this server = Asia/Ho_Chi_Minh, so every occurred_at/created_at/
// last_seen value in the DB is already a GMT+7 wall-clock string, not UTC (same reasoning as
// ssh-security-collector.js's toSqlDatetime). Date.prototype.toISOString() is UTC — using it
// directly here would silently shift every boundary by 7h and even land "today" on the wrong
// calendar day for anyone querying before 07:00 local time. Mirror the same sv-SE trick used
// everywhere else in this codebase to get Vietnam-local strings instead.
function toVnDateTime(date) { return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }); }
function toVnDate(date) { return toVnDateTime(date).slice(0, 10); }

// Zero-filled array of 'YYYY-MM-DD' (Vietnam-local) for the last `days` days ending at `untilDate`
// (oldest first) — so the trend chart never has a gap for a day with zero events (a flat 0 reads
// very differently from "no data").
function buildDateRange(days, untilDate) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(untilDate.getTime() - i * 86400000);
    out.push(toVnDate(d));
  }
  return out;
}

function countByDay(rows, dateField, dateRange) {
  const map = new Map();
  for (const r of rows) {
    const day = String(r[dateField]).slice(0, 10);
    map.set(day, (map.get(day) || 0) + 1);
  }
  return dateRange.map(d => map.get(d) || 0);
}

function topBy(rows, keyFn, limit = 10) {
  const map = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (key) map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([key, cnt]) => ({ key, cnt })).sort((a, b) => b.cnt - a.cnt).slice(0, limit);
}

// Signed % change from `prev` to `curr` — null when there's no meaningful baseline (both zero, or
// prev was zero — "+∞%" is not a useful number to show on a KPI card, the UI falls back to just
// showing the raw delta count in that case).
function pctChange(curr, prev) {
  if (prev === 0) return curr === 0 ? 0 : null;
  return Math.round(((curr - prev) / prev) * 100);
}

// Pulls the 3 raw signals (SSH-blocked-foreign, WAF-blocked-foreign, outbound-foreign) for one
// [sinceStr, untilStr) window — shared by the current AND previous period so the % change
// comparison below runs the exact same logic on both, not two subtly different query shapes.
async function fetchPeriod(sinceStr, untilStr) {
  const sshBanAlerts = await db.prepare(`
    SELECT source_id AS vm_id, source_name AS vm_name, metric_value AS ip, created_at
    FROM alerts
    WHERE metric = 'fail2ban_ban' AND message LIKE '%jail "sshd"%' AND created_at >= ? AND created_at < ?
    ORDER BY created_at DESC
  `).all(sinceStr, untilStr);
  const sshForeign = sshBanAlerts.map(r => ({ ...r, ...classifyIp(r.ip) })).filter(r => r.isForeign);

  const wafBanAlerts = await db.prepare(`
    SELECT source_id AS vm_id, source_name AS vm_name, metric_value AS ip, created_at
    FROM alerts
    WHERE metric = 'fail2ban_ban' AND message LIKE '%jail "netadmin-waf"%' AND created_at >= ? AND created_at < ?
    ORDER BY created_at DESC
  `).all(sinceStr, untilStr);
  const wafForeign = wafBanAlerts.map(r => ({ ...r, ...classifyIp(r.ip) })).filter(r => r.isForeign);

  // Best-effort attack_category per (vm_id, ip) from waf_events in the same window — alerts don't
  // carry it, this is purely extra detail for the WAF breakdown/detail table (picks the category
  // with the most hits if an IP triggered more than one kind in the window).
  const categoryRows = await db.prepare(`
    SELECT vm_id, src_ip, attack_category, COUNT(*) as cnt
    FROM waf_events
    WHERE occurred_at >= ? AND occurred_at < ? AND src_ip IS NOT NULL AND attack_category IS NOT NULL
    GROUP BY vm_id, src_ip, attack_category
  `).all(sinceStr, untilStr);
  const categoryByKey = new Map();
  for (const row of categoryRows) {
    const key = `${row.vm_id}:${row.src_ip}`;
    const existing = categoryByKey.get(key);
    if (!existing || row.cnt > existing.cnt) categoryByKey.set(key, row);
  }
  wafForeign.forEach(r => { r.attackCategory = categoryByKey.get(`${r.vm_id}:${r.ip}`)?.attack_category || null; });

  // Outbound already stores country/is_foreign per row (outbound-connection-collector.js) — no
  // classifyIp() re-derivation needed here.
  const outboundForeign = await db.prepare(`
    SELECT vm_id, vm_name, remote_ip, remote_port, country, process_name, first_seen, last_seen
    FROM outbound_connections
    WHERE is_foreign = 1 AND last_seen >= ? AND last_seen < ?
    ORDER BY last_seen DESC
  `).all(sinceStr, untilStr);

  return { sshForeign, wafForeign, outboundForeign };
}

router.get('/foreign-security', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), MAX_DAYS);
  const now = new Date();
  const since = new Date(now.getTime() - days * 86400000);
  const prevSince = new Date(since.getTime() - days * 86400000);
  const sinceStr = toVnDate(since) + ' 00:00:00';
  const nowStr = toVnDateTime(now);
  const prevSinceStr = toVnDate(prevSince) + ' 00:00:00';

  const [curr, prev] = await Promise.all([
    fetchPeriod(sinceStr, nowStr),
    fetchPeriod(prevSinceStr, sinceStr),
  ]);

  const dateRange = buildDateRange(days, now);
  const timeline = {
    dates: dateRange,
    sshBlocked: countByDay(curr.sshForeign, 'created_at', dateRange),
    wafBlocked: countByDay(curr.wafForeign, 'created_at', dateRange),
    outbound: countByDay(curr.outboundForeign, 'last_seen', dateRange),
  };

  const countriesInvolved = new Set(
    [...curr.sshForeign, ...curr.wafForeign, ...curr.outboundForeign].map(r => r.country).filter(Boolean)
  ).size;
  const countriesInvolvedPrev = new Set(
    [...prev.sshForeign, ...prev.wafForeign, ...prev.outboundForeign].map(r => r.country).filter(Boolean)
  ).size;

  const summaryMetric = (currVal, prevVal) => ({ value: currVal, previousValue: prevVal, changePct: pctChange(currVal, prevVal) });

  const rename = (rows) => rows.map(({ key, cnt }) => ({ key, cnt }));

  res.json({
    range: { days, since: sinceStr, until: nowStr },
    summary: {
      sshBlocked: summaryMetric(curr.sshForeign.length, prev.sshForeign.length),
      wafBlocked: summaryMetric(curr.wafForeign.length, prev.wafForeign.length),
      outboundForeign: summaryMetric(curr.outboundForeign.length, prev.outboundForeign.length),
      countriesInvolved: summaryMetric(countriesInvolved, countriesInvolvedPrev),
    },
    timeline,
    topCountriesInbound: rename(topBy([...curr.sshForeign, ...curr.wafForeign], r => r.country)),
    topCountriesOutbound: rename(topBy(curr.outboundForeign, r => r.country)),
    topAttackCategories: rename(topBy(curr.wafForeign, r => r.attackCategory)),
    topVmsTargeted: rename(topBy([...curr.sshForeign, ...curr.wafForeign], r => r.vm_name)),
    // Capped — this is a report view, not a raw export API; 500 rows/section is already far beyond
    // what's useful to scroll through in the UI, and keeps the response bounded regardless of how
    // wide a date range gets requested. Detail tables paginate/sort/search client-side over this.
    sshDetails: curr.sshForeign.slice(0, 500),
    wafDetails: curr.wafForeign.slice(0, 500),
    outboundDetails: curr.outboundForeign.slice(0, 500),
  });
});

module.exports = router;
