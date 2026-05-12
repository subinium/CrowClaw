/**
 * v0.9.0 (#298) — Centralized SSRF preflight for every tool that makes
 * outbound HTTP requests. Hermes v0.13 (#21228, closes #16234) shipped this
 * preemptively because the browser hybrid-routing path could be coerced into
 * hitting cloud-metadata endpoints when the SSRF floor was only enforced on
 * the legacy fetch path.
 *
 * Design:
 *  - One choke point: `assertSafeUrl(url, { kind })`.
 *  - `kind` is informational/audit only — the *same* blocklist applies to
 *    `'fetch' | 'browser' | 'vision' | 'image'`. Hermes shipped per-kind
 *    blocklists; we collapse to one to prevent drift.
 *  - Cloud-metadata hosts (AWS / GCP / Azure / Alibaba / Oracle) are blocked
 *    by *hostname* match before any DNS resolution. A literal IP for the same
 *    endpoint is then caught by the existing v0.8.2 #261/#280 private-IP
 *    blocklist in `@crowclaw/core/security`.
 *  - DNS-aware: when `node:dns` is available the resolver re-checks every
 *    resolved address so a hostname that points to 169.254.169.254 (1s-TTL
 *    record) cannot bypass the floor.
 *
 * Why a separate file vs. reusing security.ts:
 *  - `@crowclaw/core/security.ts` is the runtime-agnostic primitive layer
 *    (`validateFetchUrl`, `resolveAndValidateUrl`, IPv4/IPv6 CIDR helpers).
 *  - The cloud-metadata floor is *policy* — owned by tools/, configurable in
 *    the future, and pairs with the security-event audit shape that lives in
 *    @crowclaw/core. Splitting keeps the primitives lean.
 */

import { resolveAndValidateUrl, validateFetchUrl } from '@crowclaw/core';

/**
 * Mirror of `UrlSafetyOptions` from `@crowclaw/core/security.ts`. Kept local
 * because that interface is not (yet) re-exported from `@crowclaw/core`'s
 * barrel and we deliberately avoid editing the core package in this branch
 * (Agent C surface). When the core export lands, replace this with a direct
 * `import type { UrlSafetyOptions } from '@crowclaw/core'` and the rest of
 * the file is unchanged.
 */
export interface UrlSafetyOptions {
  /**
   * Comma-separated CIDRs or literal host/IP entries that may bypass the
   * default private-network SSRF block. Intended for explicit tailnet opt-in
   * through CROWCLAW_TAILNET_ALLOWLIST.
   */
  tailnetAllowlist?: string | string[];
  env?: Record<string, string | undefined>;
}

/**
 * Cloud-metadata endpoints. Any URL whose *hostname* matches one of these is
 * rejected up-front. The corresponding *IP* literals are already covered by
 * the private-IP regex blocklist in security.ts (169.254.0.0/16 link-local,
 * fd00::/8 ULA), so this list exists for the hostname-spelled cases — e.g.
 * `http://metadata.google.internal/computeMetadata/v1/...`.
 *
 * Mirrors Hermes' `CLOUD_METADATA_HOSTS` constant (#21228) plus Alibaba and
 * Oracle Cloud which Hermes added in a follow-up.
 */
export const CLOUD_METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254',        // AWS / GCP / Azure / DigitalOcean IPv4 IMDS
  'fd00:ec2::254',          // AWS IPv6 IMDS
  'metadata.google.internal', // GCP DNS form
  'metadata.azure.com',     // Azure DNS form (rarely used; IMDS is IP-only)
  '100.100.100.200',        // Alibaba Cloud metadata
  '192.0.0.192',            // Oracle Cloud (OCI) metadata (legacy v1)
]);

/**
 * What the caller is trying to do. Recorded into the SSRF denial envelope so
 * the audit log can show which surface was attacked. Has NO bearing on the
 * blocklist applied — every kind hits the same floor.
 */
export type SsrfKind = 'fetch' | 'browser' | 'vision' | 'image';

export interface AssertSafeUrlOptions extends UrlSafetyOptions {
  /** What the caller is doing. Recorded in the audit envelope. */
  kind: SsrfKind;
  /**
   * Override the DNS resolver. Defaults to `node:dns.promises.lookup`. Tests
   * pass a stub; the cloudflare-workers build leaves it null (regex-only).
   */
  dnsLookup?: ((hostname: string) => Promise<string[]>) | null;
}

export interface SsrfDeniedResult {
  safe: false;
  /** Stable code used by the tool envelope and audit log. */
  code: 'SSRF_CLOUD_METADATA' | 'SSRF_PRIVATE_NETWORK' | 'SSRF_INVALID_URL';
  reason: string;
  /** Hostname extracted from the URL. */
  host?: string;
  /** Resolved IP that triggered the denial, if DNS resolution ran. */
  resolvedIp?: string;
  /** The kind passed in by the caller, echoed for audit-log routing. */
  kind: SsrfKind;
}

export interface SsrfAllowedResult {
  safe: true;
  host: string;
  resolvedIps?: string[];
  kind: SsrfKind;
}

export type AssertSafeUrlResult = SsrfDeniedResult | SsrfAllowedResult;

let cachedDnsLookup: ((hostname: string) => Promise<string[]>) | null | undefined;

async function loadDefaultDnsLookup(): Promise<((hostname: string) => Promise<string[]>) | null> {
  if (cachedDnsLookup !== undefined) return cachedDnsLookup;
  try {
    const dns = (await import('node:dns')) as unknown as {
      promises: { lookup(host: string, options: { all: true }): Promise<Array<{ address: string }>> };
    };
    cachedDnsLookup = async (host: string) => {
      const records = await dns.promises.lookup(host, { all: true });
      return records.map((record) => record.address);
    };
  } catch {
    cachedDnsLookup = null;
  }
  return cachedDnsLookup;
}

function extractHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Match a host string against CLOUD_METADATA_HOSTS. Case-insensitive on the
 * input. IPv6 brackets are already stripped by `extractHost`. Returns the
 * canonical entry that matched so audit logs show the exact host attacked.
 */
function matchCloudMetadataHost(host: string): string | null {
  const normalized = host.toLowerCase();
  // Direct match against the set (covers IPv4, GCP DNS, Azure DNS, OCI/Alibaba IPs).
  if (CLOUD_METADATA_HOSTS.has(normalized)) return normalized;
  // IPv6 — the set holds `fd00:ec2::254`; URL hostnames preserve the form so
  // a literal match is sufficient. Defensive: also match the bracketed form
  // if it slipped through extraction.
  const debracketed = normalized.replace(/^\[|\]$/g, '');
  if (CLOUD_METADATA_HOSTS.has(debracketed)) return debracketed;
  return null;
}

/**
 * Central SSRF preflight. Returns either a `safe: true` envelope (the caller
 * may proceed; `resolvedIps` is set when DNS resolution ran) or a structured
 * `SsrfDeniedResult` (the caller MUST refuse).
 *
 * Order of checks (fail-fast):
 *  1. URL parses to a valid `http:` / `https:` URL.
 *  2. Hostname is not in CLOUD_METADATA_HOSTS.
 *  3. Hostname/IP literal is not in the private-network regex blocklist.
 *  4. DNS resolution (when available) — every resolved IP rechecked against
 *     CLOUD_METADATA_HOSTS *and* the private blocklist.
 *
 * The DNS-aware step is what closes the rebinding bypass: a public-looking
 * hostname can't lie about its IP for the duration of one fetch.
 */
export async function assertSafeUrl(
  url: string,
  options: AssertSafeUrlOptions,
): Promise<AssertSafeUrlResult> {
  const kind = options.kind;

  // Step 0: parse + protocol check. We do this *first* so a malformed URL
  // can't trip the cloud-metadata host check with a garbage hostname.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, code: 'SSRF_INVALID_URL', reason: 'Invalid URL format', kind };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      safe: false,
      code: 'SSRF_INVALID_URL',
      reason: `Disallowed protocol: ${parsed.protocol}`,
      host: extractHost(url) ?? undefined,
      kind,
    };
  }

  // Step 1: cloud-metadata hostname check *before* the private-network regex.
  // Why first: `metadata.google.internal` ends in `.internal`, which the
  // private-network regex (covering `.internal` / `.local`) would catch as
  // SSRF_PRIVATE_NETWORK — burying the forensic signal that this was a
  // cloud-credential exfiltration attempt. Triage cares about the
  // discriminator, so the dedicated code wins when both apply.
  const host = extractHost(url);
  if (!host) {
    return { safe: false, code: 'SSRF_INVALID_URL', reason: 'unparseable host', kind };
  }
  const cloudHit = matchCloudMetadataHost(host);
  if (cloudHit) {
    return {
      safe: false,
      code: 'SSRF_CLOUD_METADATA',
      reason: `Cloud-metadata host blocked: ${cloudHit}`,
      host: cloudHit,
      kind,
    };
  }

  // Step 2: private-network regex via the existing primitive. Same blocklist
  // as before — only the ordering relative to cloud-metadata changed.
  const base = validateFetchUrl(url, options);
  if (!base.safe) {
    const code: SsrfDeniedResult['code'] =
      base.reason?.includes('private/internal') ? 'SSRF_PRIVATE_NETWORK'
        : 'SSRF_INVALID_URL';
    return { safe: false, code, reason: base.reason ?? 'invalid URL', host, kind };
  }

  // Step 3 (implicit, via Step 2): the private-network regex already ran in
  // validateFetchUrl when the URL contained an IP literal. Hostnames that
  // resolve to private IPs are caught in step 4.

  // Step 4: DNS-aware re-validation. Skip on runtimes without node:dns
  // (Cloudflare Workers); regex-only validation has to be enough there.
  const lookup = options.dnsLookup === undefined ? await loadDefaultDnsLookup() : options.dnsLookup;
  if (!lookup) {
    return { safe: true, host, kind };
  }
  const resolved = await resolveAndValidateUrl(url, lookup, options);
  if (!resolved.safe) {
    // resolveAndValidateUrl returns the bad IP in `reason`. We also re-check
    // for cloud-metadata IPs explicitly so the code reflects the *real*
    // reason (not just "private/internal network"). Hermes saw enough
    // confusion in incident triage to warrant the dedicated code.
    const ips = resolved.resolvedIps ?? [];
    const metadataIp = ips.find((ip) => CLOUD_METADATA_HOSTS.has(ip.toLowerCase()));
    if (metadataIp) {
      return {
        safe: false,
        code: 'SSRF_CLOUD_METADATA',
        reason: `Hostname resolves to cloud-metadata IP: ${metadataIp}`,
        host,
        resolvedIp: metadataIp,
        kind,
      };
    }
    const badIp = ips.find((ip) => resolved.reason?.includes(ip));
    return {
      safe: false,
      code: 'SSRF_PRIVATE_NETWORK',
      reason: resolved.reason ?? 'resolves to private network',
      host,
      resolvedIp: badIp,
      kind,
    };
  }

  return { safe: true, host, resolvedIps: resolved.resolvedIps, kind };
}

/**
 * Convenience: convert an `SsrfDeniedResult` into the user-facing
 * `output: "URL blocked: ..."` string the existing tools already return, so
 * adopting `assertSafeUrl` doesn't break test fixtures.
 */
export function ssrfDenialMessage(result: SsrfDeniedResult): string {
  return `URL blocked: ${result.reason}`;
}

/**
 * Build the audit-log payload for a denied request. Callers feed this into
 * `SecurityAuditLog.record({ type: 'ssrf_blocked', ... })`. The detail string
 * is structured (host, kind, code, optional resolvedIp) so dashboards can
 * parse it without a schema migration.
 */
export function ssrfAuditDetail(result: SsrfDeniedResult): string {
  const parts = [
    `kind=${result.kind}`,
    `code=${result.code}`,
    `host=${result.host ?? 'n/a'}`,
  ];
  if (result.resolvedIp) parts.push(`resolvedIp=${result.resolvedIp}`);
  parts.push(`reason=${result.reason}`);
  return parts.join(' ');
}
