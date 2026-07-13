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

// Zero-filled array of 'YYYY-MM-DD' for the last `days` days (oldest first) — so the trend chart
// never has a gap for a day with zero events (a flat 0 reads very differently from "no data").
function buildDateRange(days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
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

function topCountries(rows, limit = 10) {
  const map = new Map();
  for (const r of rows) { if (r.country) map.set(r.country, (map.get(r.country) || 0) + 1); }
  return [...map.entries()].map(([country, cnt]) => ({ country, cnt })).sort((a, b) => b.cnt - a.cnt).slice(0, limit);
}

router.get('/foreign-security', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), MAX_DAYS);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) + ' 00:00:00';

  // Sourced from `alerts` (metric='fail2ban_ban') rather than ssh_banned_ips/waf_banned_ips — those
  // 2 tables only reflect the CURRENT live-banned set (a row disappears the moment a ban lifts), so
  // they'd silently undercount anything blocked-then-later-unbanned/expired within the report
  // window. `alerts` is append-only and never deleted, making it the accurate historical source.
  // Jail is embedded in the message text (see fail2ban-collector.js's raiseBanAlert) — filtering on
  // that fixed, app-controlled string is reliable here (not user input).
  const sshBanAlerts = await db.prepare(`
    SELECT source_id AS vm_id, source_name AS vm_name, metric_value AS ip, created_at
    FROM alerts
    WHERE metric = 'fail2ban_ban' AND message LIKE '%jail "sshd"%' AND created_at >= ?
    ORDER BY created_at DESC
  `).all(since);
  const sshForeign = sshBanAlerts.map(r => ({ ...r, ...classifyIp(r.ip) })).filter(r => r.isForeign);

  const wafBanAlerts = await db.prepare(`
    SELECT source_id AS vm_id, source_name AS vm_name, metric_value AS ip, created_at
    FROM alerts
    WHERE metric = 'fail2ban_ban' AND message LIKE '%jail "netadmin-waf"%' AND created_at >= ?
    ORDER BY created_at DESC
  `).all(since);
  const wafForeign = wafBanAlerts.map(r => ({ ...r, ...classifyIp(r.ip) })).filter(r => r.isForeign);

  // Best-effort attack_category per (vm_id, ip) from waf_events in the same window — alerts don't
  // carry it, this is purely extra detail for the WAF detail table (picks the category with the
  // most hits if an IP triggered more than one kind).
  const categoryRows = await db.prepare(`
    SELECT vm_id, src_ip, attack_category, COUNT(*) as cnt
    FROM waf_events
    WHERE occurred_at >= ? AND src_ip IS NOT NULL AND attack_category IS NOT NULL
    GROUP BY vm_id, src_ip, attack_category
  `).all(since);
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
    WHERE is_foreign = 1 AND last_seen >= ?
    ORDER BY last_seen DESC
  `).all(since);

  const dateRange = buildDateRange(days);
  const timeline = {
    dates: dateRange,
    sshBlocked: countByDay(sshForeign, 'created_at', dateRange),
    wafBlocked: countByDay(wafForeign, 'created_at', dateRange),
    outbound: countByDay(outboundForeign, 'last_seen', dateRange),
  };

  const countriesInvolved = new Set(
    [...sshForeign, ...wafForeign, ...outboundForeign].map(r => r.country).filter(Boolean)
  ).size;

  res.json({
    range: { days, since },
    summary: {
      sshBlocked: sshForeign.length,
      wafBlocked: wafForeign.length,
      outboundForeign: outboundForeign.length,
      countriesInvolved,
    },
    timeline,
    topCountriesInbound: topCountries([...sshForeign, ...wafForeign]),
    topCountriesOutbound: topCountries(outboundForeign),
    // Capped — this is a report view, not a raw export API; 500 rows/section is already far beyond
    // what's useful to scroll through in the UI, and keeps the response bounded regardless of how
    // wide a date range gets requested.
    sshDetails: sshForeign.slice(0, 500),
    wafDetails: wafForeign.slice(0, 500),
    outboundDetails: outboundForeign.slice(0, 500),
  });
});

module.exports = router;
