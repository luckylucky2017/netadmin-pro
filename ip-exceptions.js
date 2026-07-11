// Pure IP/CIDR exception-matching logic, shared by waf-manager.js (waf_ip_exceptions) and
// fail2ban-manager.js (ssh_ip_exceptions) — two deliberately SEPARATE exception lists (an admin may
// trust an IP for SSH but not WAF, or vice versa), but the matching rule itself (exact match, or
// IPv4 CIDR range) is identical, so it lives here once instead of drifting between two copies.
// No DB access here — each caller owns its own getExceptions() querying its own table.

// IPv4/IPv6 charset only — used by callers as defense-in-depth before interpolating an IP into a
// remote shell command.
const SAFE_IP_RE = /^[0-9a-fA-F:.]+$/;

function isIpv4(ip) { return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip || ''); }

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Pure, testable: does `ip` fall under exception entry `entryIp`? entryIp may be a bare IPv4/IPv6
// address (exact match) or an IPv4 CIDR range like "203.0.113.0/24" — CIDR ranges are IPv4-only,
// IPv6 exceptions are always exact-match to keep this simple.
function matchesException(ip, entryIp) {
  if (!ip || !entryIp) return false;
  const cidrM = /^(.+)\/(\d{1,2})$/.exec(entryIp);
  if (cidrM && isIpv4(cidrM[1]) && isIpv4(ip)) {
    const prefixLen = Number(cidrM[2]);
    if (prefixLen < 0 || prefixLen > 32) return false;
    const mask = prefixLen === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
    const a = ipv4ToInt(ip), b = ipv4ToInt(cidrM[1]);
    if (a === null || b === null) return false;
    return (a & mask) === (b & mask);
  }
  return ip === entryIp;
}

function isExceptedIp(ip, exceptions) {
  return exceptions.some(e => matchesException(ip, e.ip));
}

// fail2ban's own `ignoreip` directive — an IP listed here is NEVER banned by fail2ban itself,
// enforced at the jail level independent of this app's own isExceptedIp() check before every
// banIp() call. Defense in depth: even a ban issued completely outside this app (a raw
// `fail2ban-client banip` run by hand on the VM) is still refused. Always keeps the localhost
// defaults — a per-jail `ignoreip` REPLACES fail2ban's own [DEFAULT] value entirely rather than
// merging with it, so omitting them here would silently stop protecting localhost from itself.
function buildIgnoreIpLine(exceptions) {
  return ['ignoreip = 127.0.0.1/8 ::1', ...exceptions.map(e => e.ip)].join(' ');
}

module.exports = { SAFE_IP_RE, isIpv4, ipv4ToInt, matchesException, isExceptedIp, buildIgnoreIpLine };
