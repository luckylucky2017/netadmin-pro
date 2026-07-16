// Extra vulnerability-intelligence sources layered ON TOP of OSV.dev (vuln-scanner.js's primary
// source) — these don't find NEW vulnerabilities OSV doesn't already have, they help prioritize the
// ones OSV already found:
//   - CISA KEV (Known Exploited Vulnerabilities) — a free, static JSON catalog of CVEs CONFIRMED to
//     be actively exploited in the wild right now. The single strongest "fix this first" signal there
//     is, regardless of CVSS/severity bucket. Refetched at most once per KEV_REFETCH_INTERVAL_MS and
//     cached in memory as a Set<cveId> — the catalog changes at most a few times a week, no need to
//     hit it every scan.
//   - EPSS (Exploit Prediction Scoring System, first.org) — a free API giving a 0-1 probability score
//     estimating exploitation likelihood in the next 30 days. Queried in batches per scan (comma-
//     separated CVE IDs), not per-finding.
//   - NVD (National Vulnerability Database) — queried LAZILY, on-demand, only when an admin opens a
//     specific finding's detail modal, NOT during the bulk scan. NVD's public rate limit without an
//     API key is low (5 req/30s) — fine for one-off lookups, would make a 150-finding bulk scan take
//     many minutes if done eagerly for every finding. Adds NVD's own CVSS score/vector + CWE
//     classification, which OSV doesn't always carry for distro-sourced (Ubuntu/Debian) entries.
//
// All three are best-effort: a network failure here must never fail the underlying vuln scan or block
// the UI — every function here fails open (returns an empty/null result) rather than throwing.
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const EPSS_URL = 'https://api.first.org/data/v1/epss';
const NVD_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const KEV_REFETCH_INTERVAL_MS = 12 * 60 * 60 * 1000; // KEV catalog updates a few times/week at most
const EPSS_BATCH_CHUNK = 100; // matches EPSS's own observed default page size
const NVD_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — enough to avoid re-hitting NVD if the same finding's modal is reopened

// Pure, testable: the canonical "CVE-YYYY-NNNNN" ID for a finding — OSV's own `id` field IS already
// that for ecosystems like Debian, but Ubuntu's OSV entries use their own "UBUNTU-CVE-..." advisory
// ID as the primary id, with the real CVE tucked into `upstream` — confirmed against 10 real findings
// (every one had exactly one upstream entry, always the canonical CVE ID).
function extractCanonicalCveId(detail) {
  if (/^CVE-\d{4}-\d+$/.test(detail?.id || '')) return detail.id;
  const upstream = detail?.upstream || [];
  return upstream.find((id) => /^CVE-\d{4}-\d+$/.test(id)) || null;
}

let kevCache = { set: null, fetchedAt: 0 };

async function getKevSet() {
  if (kevCache.set && Date.now() - kevCache.fetchedAt < KEV_REFETCH_INTERVAL_MS) return kevCache.set;
  try {
    // A plain fetch with no User-Agent gets a 403 from CISA's WAF on some networks — a browser-like
    // UA is required, confirmed against the real feed.
    const res = await fetch(KEV_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; netadmin-pro)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const set = new Set((data.vulnerabilities || []).map((v) => v.cveID));
    kevCache = { set, fetchedAt: Date.now() };
    return set;
  } catch (e) {
    console.error('[vuln-enrichment] Không tải được CISA KEV:', e.message);
    return kevCache.set || new Set(); // fall back to a stale cache if we have one, else empty — never blocks the scan
  }
}

// Batch — EPSS accepts a comma-separated `cve=` list; chunked well under any practical URL-length
// limit. Returns a Map<cveId, {score, percentile}>; CVE IDs with no EPSS data simply aren't in the map.
async function queryEpssBatch(cveIds) {
  const scores = new Map();
  const unique = [...new Set(cveIds)].filter(Boolean);
  for (let i = 0; i < unique.length; i += EPSS_BATCH_CHUNK) {
    const chunk = unique.slice(i, i + EPSS_BATCH_CHUNK);
    try {
      const res = await fetch(`${EPSS_URL}?cve=${chunk.join(',')}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const row of data.data || []) {
        scores.set(row.cve, { score: parseFloat(row.epss), percentile: parseFloat(row.percentile) });
      }
    } catch (e) {
      console.error('[vuln-enrichment] Không tải được EPSS:', e.message);
      // best-effort — this chunk simply gets no scores, doesn't throw
    }
  }
  return scores;
}

const nvdCache = new Map(); // cveId -> { data, fetchedAt }

// Live, on-demand only — NOT called during the bulk scan. Returns null on any failure (rate limit,
// network, CVE not found in NVD yet) rather than throwing, since this is a "nice to have" detail-modal
// enrichment, never required data.
async function fetchNvdDetail(cveId) {
  const cached = nvdCache.get(cveId);
  if (cached && Date.now() - cached.fetchedAt < NVD_CACHE_TTL_MS) return cached.data;
  try {
    const res = await fetch(`${NVD_URL}?cveId=${encodeURIComponent(cveId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const summary = extractNvdSummary(data);
    nvdCache.set(cveId, { data: summary, fetchedAt: Date.now() });
    return summary;
  } catch (e) {
    console.error(`[vuln-enrichment] Không tải được NVD cho ${cveId}:`, e.message);
    return null;
  }
}

// Pure, testable: NVD carries multiple possible CVSS metric versions per CVE (v4.0/v3.1/v3.0/v2) —
// prefers the newest available rather than enumerating one specific version, same reasoning as
// vuln-scanner.js's extractSeverity CVSS_* handling.
function extractNvdSummary(data) {
  const cve = data?.vulnerabilities?.[0]?.cve;
  if (!cve) return null;
  const metrics = cve.metrics || {};
  const cvssEntry = (metrics.cvssMetricV40 || metrics.cvssMetricV31 || metrics.cvssMetricV30 || metrics.cvssMetricV2 || [])[0];
  const cwes = [...new Set(
    (cve.weaknesses || []).flatMap((w) => (w.description || []).filter((d) => d.lang === 'en').map((d) => d.value))
  )];
  return {
    cvssVersion: cvssEntry?.cvssData?.version || null,
    cvssScore: cvssEntry?.cvssData?.baseScore ?? null,
    cvssSeverity: cvssEntry?.cvssData?.baseSeverity || null,
    cvssVector: cvssEntry?.cvssData?.vectorString || null,
    cwes,
    nvdUrl: `https://nvd.nist.gov/vuln/detail/${data.vulnerabilities[0].cve.id}`,
  };
}

module.exports = { getKevSet, extractCanonicalCveId, queryEpssBatch, fetchNvdDetail, extractNvdSummary };
