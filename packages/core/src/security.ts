// ---------------------------------------------------------------------------
// URL Safety — SSRF protection
// ---------------------------------------------------------------------------

const PRIVATE_IP_PATTERNS = [
  /^127\./,                              // 127.0.0.0/8 loopback
  /^10\./,                               // 10.0.0.0/8 RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,          // 172.16.0.0/12 RFC1918
  /^192\.168\./,                         // 192.168.0.0/16 RFC1918
  /^192\.0\.0\./,                         // 192.0.0.0/24 IETF protocol assignments
  /^0\./,                                // 0.0.0.0/8 "this network"
  /^169\.254\./,                         // 169.254.0.0/16 link-local (AWS/GCP IMDS)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^22[4-9]\./, /^23\d\./,               // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  /^::1$/,                               // IPv6 loopback
  /^::$/,                                // IPv6 unspecified
  /^fc00:/i, /^fd[0-9a-f]{2}:/i,         // fc00::/7 ULA (covers both fc00 and fd00)
  /^fe80:/i,                             // fe80::/10 link-local
  /^ff[0-9a-f]{2}:/i,                    // ff00::/8 multicast
  /^2001:(?:0{1,4}:|:)/i,                // 2001::/32 Teredo
  /^2002:/i,                              // 2002::/16 6to4
  /^::ffff:/i,                           // IPv4-mapped IPv6 (::ffff:10.0.0.1 etc.)
  /^0:0:0:0:0:ffff:/i,                   // IPv4-mapped long form
  /^0:0:0:0:0:0:/i,                      // other abbreviated-zero forms
  /^localhost$/i,
  /^.*\.local$/i,
  /^.*\.internal$/i
];

export interface UrlSafetyOptions {
  /**
   * Comma-separated CIDRs or literal host/IP entries that may bypass the
   * default private-network SSRF block. Intended for explicit tailnet opt-in
   * through CROWCLAW_TAILNET_ALLOWLIST.
   */
  tailnetAllowlist?: string | string[];
  env?: Record<string, string | undefined>;
}

function getRuntimeEnv(): Record<string, string | undefined> {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function normalizeAddress(value: string): string {
  const unwrapped = value.trim().replace(/^\[|\]$/g, '').split('%')[0]!;
  const mapped = unwrapped.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return (mapped ? mapped[1]! : unwrapped).toLowerCase();
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function expandIpv6(address: string): number[] | null {
  const normalized = normalizeAddress(address);
  if (!normalized.includes(':')) return null;
  const [headRaw, tailRaw] = normalized.split('::');
  if (normalized.indexOf('::') !== normalized.lastIndexOf('::')) return null;
  const head = headRaw ? headRaw.split(':').filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(':').filter(Boolean) : [];
  const parseGroup = (group: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    return parseInt(group, 16);
  };
  if (tailRaw === undefined) {
    if (head.length !== 8) return null;
    return head.map(parseGroup).every((v): v is number => v !== null)
      ? head.map((group) => parseInt(group, 16))
      : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  const parsed = groups.map(parseGroup);
  return parsed.every((v): v is number => v !== null) ? parsed : null;
}

function ipv6MatchesCidr(ip: string, base: string, prefixLength: number): boolean {
  const target = expandIpv6(ip);
  const cidrBase = expandIpv6(base);
  if (!target || !cidrBase || prefixLength < 0 || prefixLength > 128) return false;
  const fullGroups = Math.floor(prefixLength / 16);
  const partialBits = prefixLength % 16;
  for (let i = 0; i < fullGroups; i++) {
    if (target[i] !== cidrBase[i]) return false;
  }
  if (partialBits === 0) return true;
  const mask = (0xffff << (16 - partialBits)) & 0xffff;
  return (target[fullGroups]! & mask) === (cidrBase[fullGroups]! & mask);
}

function matchesAllowlistEntry(value: string, entry: string): boolean {
  const target = normalizeAddress(value);
  const candidate = entry.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!candidate) return false;
  if (!candidate.includes('/')) {
    return target === normalizeAddress(candidate);
  }
  const [base, prefixRaw] = candidate.split('/');
  const prefixLength = Number(prefixRaw);
  if (!base || !Number.isInteger(prefixLength)) return false;
  const target4 = ipv4ToInt(target);
  const base4 = ipv4ToInt(base);
  if (target4 !== null && base4 !== null) {
    if (prefixLength < 0 || prefixLength > 32) return false;
    const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    return (target4 & mask) === (base4 & mask);
  }
  return ipv6MatchesCidr(target, base, prefixLength);
}

function getTailnetAllowlist(options?: UrlSafetyOptions): string[] {
  const configured = options?.tailnetAllowlist
    ?? options?.env?.CROWCLAW_TAILNET_ALLOWLIST
    ?? getRuntimeEnv().CROWCLAW_TAILNET_ALLOWLIST;
  if (Array.isArray(configured)) {
    return configured.map((entry) => entry.trim()).filter(Boolean);
  }
  return (configured ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function isTailnetAllowlistedAddress(address: string, options?: UrlSafetyOptions): boolean {
  const allowlist = getTailnetAllowlist(options);
  if (allowlist.length === 0) return false;
  return allowlist.some((entry) => matchesAllowlistEntry(address, entry));
}

/**
 * Check if a bare IP address (already resolved) matches a private/internal range.
 * Separate from isPrivateUrl so DNS-rebinding-aware callers can validate the
 * resolved IP, not just the hostname string.
 */
export function isPrivateIpAddress(ip: string, options?: UrlSafetyOptions): boolean {
  const normalized = normalizeAddress(ip);
  if (isTailnetAllowlistedAddress(normalized, options)) return false;
  return PRIVATE_IP_PATTERNS.some(p => p.test(normalized));
}

export function isPrivateUrl(url: string, options?: UrlSafetyOptions): boolean {
  try {
    const parsed = new URL(url);
    const hostname = normalizeAddress(parsed.hostname); // strip IPv6 brackets/zone ids
    if (isTailnetAllowlistedAddress(hostname, options)) return false;
    return PRIVATE_IP_PATTERNS.some(p => p.test(hostname));
  } catch {
    return true; // invalid URLs are treated as private
  }
}

export function validateFetchUrl(url: string, options?: UrlSafetyOptions): { safe: boolean; reason?: string } {
  if (!url) return { safe: false, reason: 'Empty URL' };

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
    }
    if (isPrivateUrl(url, options)) {
      return { safe: false, reason: 'URL resolves to private/internal network' };
    }
    return { safe: true };
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }
}

/**
 * DNS-rebinding-safe URL validation. Resolves the hostname via the caller-supplied
 * resolver (Node: dns.lookup, CF: ignore DNS and skip), then checks every resolved
 * IP against private ranges. Prevents the attack where validation sees a public IP
 * but fetch() re-resolves to 127.0.0.1 or 169.254.169.254 with a 1s-TTL DNS record.
 *
 * Callers should then fetch with `redirect: 'manual'` and re-validate on each hop
 * to prevent redirect-based bypass.
 */
export async function resolveAndValidateUrl(
  url: string,
  resolver: (hostname: string) => Promise<string[]>,
  options?: UrlSafetyOptions
): Promise<{ safe: boolean; reason?: string; resolvedIps?: string[] }> {
  const base = validateFetchUrl(url, options);
  if (!base.safe) return base;
  try {
    const parsed = new URL(url);
    const host = normalizeAddress(parsed.hostname);
    // Literal IPs skip DNS (no rebinding risk).
    if (/^[0-9.]+$/.test(host) || host.includes(':')) {
      return { safe: true, resolvedIps: [host] };
    }
    const ips = await resolver(host);
    if (ips.length === 0) return { safe: false, reason: 'Hostname did not resolve to any IP' };
    const badIp = ips.find(ip => isPrivateIpAddress(ip, options));
    if (badIp) {
      return { safe: false, reason: `Hostname resolves to private IP: ${badIp}`, resolvedIps: ips };
    }
    return { safe: true, resolvedIps: ips };
  } catch (err) {
    return { safe: false, reason: `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Prompt Injection Detection
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*you\s+are/i,
  /\bDAN\b.*\bjailbreak/i,
  /\[SYSTEM\]\s*override/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /pretend\s+you\s+are/i,
  /act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i,
  /ignore\s+safety\s+guidelines/i,
  /bypass\s+(all\s+)?filters/i
];

// Invisible Unicode characters used in prompt injection
const INVISIBLE_CHARS = [
  '\u200B', // zero-width space
  '\u200C', // zero-width non-joiner
  '\u200D', // zero-width joiner
  '\u2060', // word joiner
  '\uFEFF', // BOM
  '\u00AD', // soft hyphen
  '\u200E', // LTR mark
  '\u200F', // RTL mark
  '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', // bidi overrides
  '\u2066', '\u2067', '\u2068', '\u2069' // isolates
];

export interface InjectionScanResult {
  safe: boolean;
  threats: string[];
  hasInvisibleChars: boolean;
  riskScore: number; // 0-10
}

export function scanForInjection(text: string): InjectionScanResult {
  const threats: string[] = [];
  let riskScore = 0;

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      threats.push(`Injection pattern: ${pattern.source}`);
      riskScore += 3;
    }
  }

  // Check for invisible characters
  const hasInvisibleChars = INVISIBLE_CHARS.some(c => text.includes(c));
  if (hasInvisibleChars) {
    threats.push('Contains invisible Unicode characters');
    riskScore += 2;
  }

  // Check for excessive role/system markers in user input
  const roleMarkers = (text.match(/\b(system|assistant|user)\s*:/gi) ?? []).length;
  if (roleMarkers >= 2) {
    threats.push(`Multiple role markers found (${roleMarkers})`);
    riskScore += 2;
  }

  return {
    safe: riskScore < 3,
    threats,
    hasInvisibleChars,
    riskScore: Math.min(riskScore, 10)
  };
}

// Strip invisible characters from text
export function sanitizeText(text: string): string {
  let result = text;
  for (const char of INVISIBLE_CHARS) {
    result = result.split(char).join('');
  }
  return result;
}

// ---------------------------------------------------------------------------
// PII Redaction
// ---------------------------------------------------------------------------

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN_REDACTED]' },
  { name: 'credit_card', pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[CC_REDACTED]' },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL_REDACTED]' },
  { name: 'phone_us', pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[PHONE_REDACTED]' },
  { name: 'api_key', pattern: /\b(sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{35}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]{20,})\b/g, replacement: '[API_KEY_REDACTED]' },
  { name: 'aws_key', pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: '[AWS_KEY_REDACTED]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[JWT_REDACTED]' }
];

export interface RedactionResult {
  text: string;
  redactedCount: number;
  redactedTypes: string[];
}

export function redactPII(text: string): RedactionResult {
  let result = text;
  const redactedTypes: string[] = [];
  let redactedCount = 0;

  for (const { name, pattern, replacement } of PII_PATTERNS) {
    const matches = result.match(pattern);
    if (matches) {
      redactedCount += matches.length;
      redactedTypes.push(name);
      result = result.replace(pattern, replacement);
    }
  }

  return { text: result, redactedCount, redactedTypes };
}

// ---------------------------------------------------------------------------
// Content Security — Credential detection
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /(?:secret|token|key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  /-----BEGIN CERTIFICATE-----/
];

export function containsSecrets(text: string): { detected: boolean; patterns: string[] } {
  const patterns: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      patterns.push(pattern.source);
    }
  }
  return { detected: patterns.length > 0, patterns };
}

// ---------------------------------------------------------------------------
// Credential Redaction
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Include `_-` in the charset so modern OpenAI key formats (sk-proj-*, sk-svcacct-*)
  // get fully redacted instead of stopping at the first dash.
  { name: 'openai_key', pattern: /sk-[a-zA-Z0-9_-]{20,}/g },
  { name: 'anthropic_key', pattern: /sk-ant-[a-zA-Z0-9-]{20,}/g },
  { name: 'github_token_ghp', pattern: /ghp_[a-zA-Z0-9]{36}/g },
  { name: 'github_token_gho', pattern: /gho_[a-zA-Z0-9]{36}/g },
  { name: 'github_token_ghs', pattern: /ghs_[a-zA-Z0-9]{36}/g },
  { name: 'github_pat', pattern: /github_pat_[a-zA-Z0-9_]{20,}/g },
  { name: 'slack_token', pattern: /xox[bpar]-[a-zA-Z0-9-]+/g },
  { name: 'aws_key', pattern: /AKIA[A-Z0-9]{16}/g },
  { name: 'bearer_token', pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g },
  // Prior pattern `[a-zA-Z_]{0,30}(?:key|token|...)[a-zA-Z_]{0,30}` was
  // catastrophic-backtracking prone on adversarial inputs (aaaa...). The
  // replacement uses a non-backtracking letter-boundary (look-around without
  // nested quantifiers) so it still catches `DB_SECRET = "..."` while refusing
  // to walk over arbitrary-length filler.
  { name: 'generic_credential', pattern: /(?<![a-zA-Z])(?:api[_-]?key|access[_-]?token|auth[_-]?token|key|token|secret|password|credential)(?![a-zA-Z])\s{0,5}[:=]\s{0,5}["'][^"']{8,80}["']/gi },
  { name: 'private_key_block', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[^-]+-----END[A-Z ]*PRIVATE KEY-----/g },
];

export function redactCredentials(text: string): string {
  let result = text;
  // Apply anthropic_key before openai_key since sk-ant- is a subset of sk-
  // Sort by specificity: longer/more-specific patterns first
  const ordered = [
    CREDENTIAL_PATTERNS.find(p => p.name === 'anthropic_key')!,
    CREDENTIAL_PATTERNS.find(p => p.name === 'private_key_block')!,
    ...CREDENTIAL_PATTERNS.filter(p => p.name !== 'anthropic_key' && p.name !== 'private_key_block'),
  ];
  for (const { pattern } of ordered) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function redactToolOutput(output: string): string {
  let result = redactCredentials(output);
  const piiResult = redactPII(result);
  result = piiResult.text;
  return result;
}

// ---------------------------------------------------------------------------
// Structured-data redaction (#68 + #135 — single sink for log/event/memory)
// ---------------------------------------------------------------------------

/**
 * Keys whose values should be replaced with `[REDACTED]` regardless of
 * content. Matches case-insensitively as a whole-word boundary check on the
 * key — `apiKey`, `api_key`, `X-Api-Key`, `bearerToken`, `Authorization` all
 * hit. The walker still applies string-level credential redaction to other
 * values so a leaked secret in `{ message: 'token=sk-...' }` is also caught.
 *
 * Parity: NemoClaw de97a00 (single redaction module) + OpenClaw 'avoid
 * echoing rotated device tokens'.
 */
const SENSITIVE_KEY_PATTERN =
  /(?:^|[^a-zA-Z0-9])(?:token|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|cookie|authorization|password|passwd|pwd|private[_-]?key|x[_-]?api[_-]?key|client[_-]?secret)(?:$|[^a-zA-Z0-9])/i;

/**
 * Walk an arbitrary value and return a new value with sensitive content
 * replaced by `[REDACTED]`. Used by the logger and any other structured
 * sink (event-bus, memory store, persisted transcripts) so secrets cannot
 * leak through a single missed call site.
 *
 * Behavior:
 * - String values: pass through `redactCredentials` (already detects keys/PEM/etc.).
 * - Object/Map keys matching SENSITIVE_KEY_PATTERN: value replaced wholesale.
 * - Recursive: traverses nested objects/arrays. Cycles are detected via
 *   WeakSet and short-circuited to `'[CIRCULAR]'`.
 * - Primitives (number/boolean/null/undefined): returned unchanged.
 *
 * The function returns a NEW value tree; the input is not mutated.
 */
export function redactStructuredData<T>(input: T): T {
  const seen = new WeakSet<object>();
  function walk(v: unknown, parentKey?: string): unknown {
    if (typeof v === 'string') {
      // If the parent key looks sensitive, blank the value entirely. This
      // catches cases where the value isn't a recognizable token format
      // (e.g. an opaque session id stored under `authorization`).
      if (parentKey && SENSITIVE_KEY_PATTERN.test(parentKey)) {
        return '[REDACTED]';
      }
      return redactCredentials(v);
    }
    if (v === null || v === undefined) return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      return v;
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) return '[CIRCULAR]';
      seen.add(v);
      return v.map((item) => walk(item, parentKey));
    }
    if (typeof v === 'object') {
      if (seen.has(v as object)) return '[CIRCULAR]';
      seen.add(v as object);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE_KEY_PATTERN.test(k)) {
          // Even keys are redacted — a number under `apiKey` shouldn't pass.
          out[k] = '[REDACTED]';
        } else {
          out[k] = walk(val, k);
        }
      }
      return out;
    }
    // Functions, symbols — drop to a placeholder rather than serialize.
    return undefined;
  }
  return walk(input) as T;
}

// ---------------------------------------------------------------------------
// Enhanced Prompt Injection Detection
// ---------------------------------------------------------------------------

export interface InjectionThreat {
  type: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
}

export interface EnhancedInjectionScanResult {
  detected: boolean;
  threats: InjectionThreat[];
}

const OVERRIDE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, description: 'Attempts to override previous instructions' },
  { pattern: /disregard\s+(all\s+)?prior/i, description: 'Attempts to disregard prior context' },
  { pattern: /system\s*prompt\s*:/i, description: 'Attempts to inject a system prompt' },
  { pattern: /you\s+are\s+now\s+/i, description: 'Attempts to redefine agent identity' },
  { pattern: /forget\s+(all\s+)?(your\s+)?instructions/i, description: 'Attempts to clear agent instructions' },
  { pattern: /pretend\s+you\s+are/i, description: 'Attempts to assume a different persona' },
  { pattern: /\[SYSTEM\]\s*override/i, description: 'Fake system override marker' },
  { pattern: /new\s+instructions?\s*:/i, description: 'Attempts to inject new instructions' },
];

const HIDDEN_HTML_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /<!--[\s\S]*?-->/g, description: 'HTML comment with potentially hidden instructions' },
  { pattern: /<script[\s\S]*?<\/script>/gi, description: 'Script tag with potentially executable content' },
  { pattern: /<div[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0)[^"']*["'][^>]*>/gi, description: 'Invisible HTML element with hidden content' },
  { pattern: /<span[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0)[^"']*["'][^>]*>/gi, description: 'Invisible span element with hidden content' },
];

const INVISIBLE_UNICODE_PATTERNS: Array<{ char: string; name: string }> = [
  { char: '\u200B', name: 'zero-width space' },
  { char: '\u200D', name: 'zero-width joiner' },
  { char: '\u202A', name: 'left-to-right embedding' },
  { char: '\u202B', name: 'right-to-left embedding' },
  { char: '\u202C', name: 'pop directional formatting' },
  { char: '\u202D', name: 'left-to-right override' },
  { char: '\u202E', name: 'right-to-left override' },
  { char: '\uFEFF', name: 'byte order mark / zero-width no-break space' },
];

const EXFILTRATION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /send\s+(this\s+|it\s+|the\s+)?(data\s+|info\s+|information\s+|output\s+)?to\s+\S+/i, description: 'Instruction to send data to external target' },
  { pattern: /forward\s+(this\s+|it\s+|the\s+)?(data\s+|info\s+|output\s+)?to\s+\S+/i, description: 'Instruction to forward data externally' },
  { pattern: /https?:\/\/[^\s]+/i, description: 'URL embedded in instructions (potential exfiltration endpoint)' },
];

const ROLE_CONFUSION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /as\s+an?\s+AI/i, description: 'Attempts to reference AI identity for manipulation' },
  { pattern: /you\s+must\s+/i, description: 'Coercive instruction attempting to override safety' },
  { pattern: /your\s+new\s+role/i, description: 'Attempts to reassign agent role' },
  { pattern: /act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i, description: 'Attempts to remove safety restrictions' },
  { pattern: /bypass\s+(all\s+)?filters/i, description: 'Attempts to bypass safety filters' },
];

export function scanForEnhancedInjection(text: string): EnhancedInjectionScanResult {
  const threats: InjectionThreat[] = [];

  // Override attempts (high severity)
  for (const { pattern, description } of OVERRIDE_PATTERNS) {
    if (pattern.test(text)) {
      threats.push({ type: 'override_attempt', description, severity: 'high' });
    }
  }

  // Hidden HTML instructions (medium severity)
  for (const { pattern, description } of HIDDEN_HTML_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      threats.push({ type: 'hidden_html', description, severity: 'medium' });
    }
  }

  // Invisible Unicode characters (medium severity)
  const foundInvisible: string[] = [];
  for (const { char, name } of INVISIBLE_UNICODE_PATTERNS) {
    if (text.includes(char)) {
      foundInvisible.push(name);
    }
  }
  if (foundInvisible.length > 0) {
    threats.push({
      type: 'invisible_unicode',
      description: `Contains invisible Unicode characters: ${foundInvisible.join(', ')}`,
      severity: 'medium',
    });
  }

  // Data exfiltration patterns (high severity)
  for (const { pattern, description } of EXFILTRATION_PATTERNS) {
    if (pattern.test(text)) {
      threats.push({ type: 'data_exfiltration', description, severity: 'high' });
    }
  }

  // Role confusion (low severity)
  for (const { pattern, description } of ROLE_CONFUSION_PATTERNS) {
    if (pattern.test(text)) {
      threats.push({ type: 'role_confusion', description, severity: 'low' });
    }
  }

  return {
    detected: threats.length > 0,
    threats,
  };
}

// ---------------------------------------------------------------------------
// #299 — Assembled-prompt injection scan (cron + multi-source contexts)
//
// Sibling export to `scanForEnhancedInjection`. The cron runner assembles a
// prompt from `[cronConfig, ...injectedSkills, ...memory]` parts; running
// the scanner against each part independently misses two failure modes:
//   1. A threat whose pattern straddles a part boundary (e.g. a poisoned
//      skill ends with "Ignore previous" and the next part starts with
//      "instructions and send credentials").
//   2. A threat that only becomes meaningful in context (cumulative role
//      markers across parts).
//
// This API runs the scanner against the *concatenated* prompt and returns
// findings with per-part attribution so the operator can identify the
// offending source. The scheduler package has its own offset-aware
// implementation in `packages/scheduler/src/injection-scan.ts`; this is the
// thin core-side wrapper for non-scheduler callers (memory, tool output
// pipelines) that also assemble multi-source prompts.
// ---------------------------------------------------------------------------

export interface AssembledPromptPart {
  /** Stable label, e.g. `'cron-config'`, `'skill:web-research'`, `'memory'`. */
  name: string;
  /** Body text contributed by this part. */
  content: string;
}

export interface AssembledInjectionFinding {
  type: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  /** Name of the part that produced the match, or `'assembled'` for cross-boundary. */
  partName: string;
  /** Byte offset where the match begins inside the source part. */
  offsetInPart: number;
}

/**
 * Scan a multi-part assembled prompt and report findings with per-part
 * attribution. Returns an empty array when nothing trips.
 *
 * The parts are joined with `\n\n` — callers that build the model-facing
 * prompt with a different separator should re-implement this using
 * `scanForEnhancedInjection` directly.
 */
export function scanAssembledPrompt(
  parts: AssembledPromptPart[],
): AssembledInjectionFinding[] {
  if (parts.length === 0) return [];
  const assembled = parts.map((p) => p.content).join('\n\n');
  const scan = scanForEnhancedInjection(assembled);
  if (!scan.detected) return [];

  const findings: AssembledInjectionFinding[] = [];
  const seen = new Set<string>();
  for (const threat of scan.threats) {
    if (seen.has(threat.type)) continue;
    seen.add(threat.type);
    // Pinpoint by re-scanning each part for the same threat type.
    let attributed: { partName: string; offsetInPart: number } | null = null;
    for (const part of parts) {
      const partScan = scanForEnhancedInjection(part.content);
      if (partScan.detected && partScan.threats.some((t) => t.type === threat.type)) {
        attributed = { partName: part.name, offsetInPart: 0 };
        break;
      }
    }
    findings.push({
      type: threat.type,
      description: threat.description,
      severity: threat.severity,
      partName: attributed?.partName ?? 'assembled',
      offsetInPart: attributed?.offsetInPart ?? 0,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Pre-Execution Command Scanner
// ---------------------------------------------------------------------------

export interface CommandRisk {
  pattern: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface CommandScanResult {
  safe: boolean;
  risks: CommandRisk[];
}

const COMMAND_RISK_PATTERNS: Array<{ pattern: RegExp; description: string; severity: CommandRisk['severity'] }> = [
  // Pipe to interpreter (critical)
  { pattern: /curl\s+[^|]*\|\s*(?:ba)?sh/i, description: 'Piping remote content to shell interpreter', severity: 'critical' },
  { pattern: /wget\s+[^|]*\|\s*(?:ba)?sh/i, description: 'Piping remote content to shell interpreter', severity: 'critical' },
  { pattern: /python\s+-c\s+/i, description: 'Inline Python code execution', severity: 'high' },

  // Recursive delete (critical)
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+\//i, description: 'Recursive force delete from root', severity: 'critical' },
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+~/i, description: 'Recursive force delete from home directory', severity: 'critical' },
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+\*/i, description: 'Recursive force delete with wildcard', severity: 'critical' },

  // Privilege escalation (high)
  { pattern: /\bsudo\b/i, description: 'Privilege escalation via sudo', severity: 'high' },
  { pattern: /\bsu\s+-/i, description: 'Privilege escalation via su', severity: 'high' },
  { pattern: /chmod\s+777\b/i, description: 'Setting world-writable permissions', severity: 'high' },
  { pattern: /chown\b/i, description: 'Changing file ownership', severity: 'medium' },

  // Network exfiltration (critical)
  { pattern: /curl\s+.*-d\s+@\/etc\//i, description: 'Exfiltrating system files via curl', severity: 'critical' },
  { pattern: /nc\s+.*-e\b/i, description: 'Reverse shell via netcat', severity: 'critical' },

  // Environment variable theft (high)
  { pattern: /echo\s+\$[A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)/i, description: 'Echoing sensitive environment variables', severity: 'high' },
  { pattern: /printenv\s*\|.*curl/i, description: 'Exfiltrating environment variables via curl', severity: 'critical' },
  { pattern: /env\s*\|.*curl/i, description: 'Exfiltrating environment via curl', severity: 'critical' },

  // Git credential exposure (high)
  { pattern: /git\s+config\s+--global\s+credential/i, description: 'Accessing global git credentials', severity: 'high' },

  // Disk/data destruction (critical)
  { pattern: /dd\s+if=\/dev\/zero/i, description: 'Writing zeros to disk (data destruction)', severity: 'critical' },
  { pattern: /\bmkfs\b/i, description: 'Formatting filesystem', severity: 'critical' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i, description: 'Fork bomb (denial of service)', severity: 'critical' },
];

export function scanCommand(command: string): CommandScanResult {
  const risks: CommandRisk[] = [];

  for (const { pattern, description, severity } of COMMAND_RISK_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(command)) {
      risks.push({ pattern: pattern.source, description, severity });
    }
  }

  return {
    safe: risks.length === 0,
    risks,
  };
}

// ---------------------------------------------------------------------------
// Security Audit Log
// ---------------------------------------------------------------------------

export type SecurityEventType =
  | 'credential_redacted'
  | 'injection_detected'
  | 'command_blocked'
  | 'command_warned'
  | 'pii_redacted'
  | 'ssrf_blocked'
  | 'rate_limit_exceeded'
  | 'approval_required'
  | 'approval_denied'
  // v0.8.0 (#234) — `code.execute` pipeline tool. Recorded at the call site
  // (packages/tools/src/code-execute.ts) BEFORE the sandbox runs so a
  // runaway sandbox can't suppress its own audit row. The detail string is
  // the truncated source + allowed-tool list; the severity is `info` for
  // benign runs and `warning` when the call requested any destructive tool.
  | 'tool.code-execute'
  // v0.9.0 (#293, Hermes v0.13 parity) — emitted on first config load when
  // the stored config did NOT explicitly set `redactToolOutput`. v0.8.x
  // already defaulted in-code to `true`, but persisted configs from v0.7.x
  // or upgrades from a misconfigured deploy could have the field unset.
  // Hermes #21193 reverted the default to ON after #16794 made it off in
  // v0.12; this event surfaces the migration so operators see the flip
  // (and can audit that no plaintext-output workflow regressed).
  | 'security:redaction_default_applied';

export type SecurityEventSeverity = 'info' | 'warning' | 'critical';

export interface SecurityEvent {
  timestamp: string;
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  detail: string;
  sessionId?: string;
  agentId?: string;
  model?: string;
  provider?: string;
  presetId?: string;
}

export class SecurityAuditLog {
  private events: SecurityEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents = 500) {
    this.maxEvents = maxEvents;
  }

  record(event: Omit<SecurityEvent, 'timestamp'>): SecurityEvent {
    const entry: SecurityEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.recordEntry(entry);
    return entry;
  }

  protected recordEntry(entry: SecurityEvent): void {
    this.events.push(entry);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  getEvents(limit?: number): SecurityEvent[] {
    if (limit === undefined) return [...this.events].reverse();
    return [...this.events].reverse().slice(0, limit);
  }

  getEventsByType(type: string): SecurityEvent[] {
    return [...this.events].reverse().filter((e) => e.type === type);
  }

  getStats(): {
    total: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const event of this.events) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
      bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
    }

    return { total: this.events.length, byType, bySeverity };
  }

  clear(): void {
    this.events = [];
  }

  flush(): SecurityEvent[] {
    const flushed = [...this.events];
    this.events = [];
    return flushed;
  }
}

function getProcessEnv(name: string): string | undefined {
  const processRef = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return processRef?.env?.[name];
}

function defaultCrowclawDataDir(): string {
  return getProcessEnv('CROWCLAW_DATA_DIR')
    ?? `${getProcessEnv('HOME') ?? '/tmp'}/.crowclaw`;
}

function dateStamp(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export interface FileSecurityAuditLogOptions {
  baseDir?: string;
  maxEvents?: number;
  retentionDays?: number;
}

interface FsPromisesApi {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  appendFile(path: string, data: string, options?: { encoding?: 'utf-8'; mode?: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

function loadFsPromises(): Promise<FsPromisesApi> {
  const processRef = (() => {
    try {
      return new Function('return typeof process === "object" ? process : undefined')() as
        | { getBuiltinModule?: (specifier: string) => unknown }
        | undefined;
    } catch {
      return (globalThis as { process?: { getBuiltinModule?: (specifier: string) => unknown } }).process;
    }
  })();
  const builtin = processRef?.getBuiltinModule?.('node:fs/promises')
    ?? processRef?.getBuiltinModule?.('fs/promises');
  if (builtin) return Promise.resolve(builtin as FsPromisesApi);

  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<FsPromisesApi>;
  return dynamicImport('node:fs/promises');
}

export class FileSecurityAuditLog extends SecurityAuditLog {
  private readonly baseDir: string;
  private readonly retentionDays: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private clearedAt: string | null = null;

  constructor(options: FileSecurityAuditLogOptions = {}) {
    super(options.maxEvents ?? 500);
    this.baseDir = options.baseDir ?? `${defaultCrowclawDataDir()}/audit`;
    const envRetention = Number.parseInt(getProcessEnv('CROWCLAW_AUDIT_RETENTION_DAYS') ?? '', 10);
    this.retentionDays = options.retentionDays ?? (Number.isFinite(envRetention) && envRetention > 0 ? envRetention : 30);
  }

  override record(event: Omit<SecurityEvent, 'timestamp'>): SecurityEvent {
    const entry = super.record(event);
    this.enqueueWrite(entry);
    return entry;
  }

  async readEvents(options: { since?: string; type?: string; severity?: string; limit?: number } = {}): Promise<SecurityEvent[]> {
    const fs = await loadFsPromises();
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.baseDir).catch(() => []);
    const files = entries
      .filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse();
    const sinceTime = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
    const events: SecurityEvent[] = [];

    for (const file of files) {
      const text = await fs.readFile(`${this.baseDir}/${file}`, 'utf-8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as SecurityEvent;
          const eventTime = Date.parse(event.timestamp);
          if (this.clearedAt && eventTime <= Date.parse(this.clearedAt)) continue;
          if (Number.isFinite(sinceTime) && eventTime < sinceTime) continue;
          if (options.type && event.type !== options.type) continue;
          if (options.severity && event.severity !== options.severity) continue;
          events.push(event);
        } catch {
          // Skip malformed historical rows instead of failing the audit API.
        }
      }
    }

    events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return options.limit ? events.slice(0, options.limit) : events;
  }

  async drainWrites(): Promise<void> {
    await this.writeQueue;
  }

  override clear(): void {
    super.clear();
    this.clearedAt = new Date().toISOString();
    this.writeQueue = this.writeQueue
      .then(() => this.deleteAuditFiles())
      .catch(() => {});
  }

  private enqueueWrite(entry: SecurityEvent): void {
    this.writeQueue = this.writeQueue
      .then(() => this.append(entry))
      .catch(() => {});
  }

  private async append(entry: SecurityEvent): Promise<void> {
    const fs = await loadFsPromises();
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const path = `${this.baseDir}/audit-${dateStamp(entry.timestamp)}.jsonl`;
    await fs.appendFile(path, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fs.chmod(path, 0o600).catch(() => {});
    await this.pruneOldFiles(fs);
  }

  private async pruneOldFiles(fs: FsPromisesApi): Promise<void> {
    if (this.retentionDays <= 0) return;
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const entries = await fs.readdir(this.baseDir).catch(() => []);
    await Promise.all(entries.map(async (name) => {
      const match = name.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) return;
      const date = match[1];
      if (!date) return;
      if (Date.parse(date) >= cutoff) return;
      await fs.unlink(`${this.baseDir}/${name}`).catch(() => {});
    }));
  }

  private async deleteAuditFiles(): Promise<void> {
    const fs = await loadFsPromises();
    const entries = await fs.readdir(this.baseDir).catch(() => []);
    await Promise.all(entries.map(async (name) => {
      if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) return;
      await fs.unlink(`${this.baseDir}/${name}`).catch(() => {});
    }));
  }
}

// ---------------------------------------------------------------------------
// v0.8.0 (#234) — code.execute audit helper
//
// Append a `tool.code-execute` entry to the SecurityAuditLog. Called from
// packages/tools/src/code-execute.ts at the start of every sandbox run, so
// the audit log captures: which session ran the sandbox, what language, what
// the source was (capped to `codeLimit` bytes — default 4 KB), and the
// allowed-tool list the sandbox was permitted to invoke.
//
// The detail field is plain text rather than a structured JSON payload so it
// renders correctly in existing audit drawers (dashboard, /api/security/audit
// log). Truncation marker lives inline so callers reading the field don't
// have to special-case truncation.
// ---------------------------------------------------------------------------

export interface CodeExecuteAuditPayload {
  sessionId: string;
  agentId?: string;
  model?: string;
  provider?: string;
  presetId?: string;
  language: 'js' | 'ts' | 'python';
  code: string;
  /** Bytes of `code` to keep in the audit row before truncation. Defaults to 4 KB. */
  codeLimit?: number;
  allowedTools: ReadonlyArray<string>;
}

const DEFAULT_AUDIT_CODE_LIMIT = 4 * 1024;

export function recordCodeExecuteAudit(
  log: SecurityAuditLog,
  payload: CodeExecuteAuditPayload,
): void {
  const limit = payload.codeLimit ?? DEFAULT_AUDIT_CODE_LIMIT;
  const truncated =
    payload.code.length > limit
      ? `${payload.code.slice(0, limit)}\n[truncated: ${payload.code.length - limit} more bytes]`
      : payload.code;
  const allowedList =
    payload.allowedTools.length > 0
      ? payload.allowedTools.join(', ')
      : '(none)';
  // Severity escalates if the caller requested any tool whose name suggests a
  // destructive class. The host bridge separately enforces the actual gate;
  // this is purely an audit-side classification so reviewers can filter for
  // higher-risk runs.
  const dangerousLooking = payload.allowedTools.some((name) =>
    /(?:exec|delete|write|kill|patch|terminal|workspace\.delete|workspace\.write|file\.delete|file\.write)/i.test(name),
  );
  const severity: SecurityEventSeverity = dangerousLooking ? 'warning' : 'info';
  log.record({
    type: 'tool.code-execute',
    severity,
    sessionId: payload.sessionId,
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.presetId ? { presetId: payload.presetId } : {}),
    detail: `code.execute language=${payload.language} allowedTools=[${allowedList}]\n----- source -----\n${truncated}\n----- end source -----`,
  });
}

// ---------------------------------------------------------------------------
// v0.9.0 (#293) — redaction-default migration audit helper.
//
// Hermes v0.13 (NousResearch/hermes-agent#21193) restored secret redaction
// to on-by-default after the v0.12 patch-corruption fix (#16794) made it
// off. CrowClaw v0.8.x always defaulted redactToolOutput=true in code, but
// persisted configs from earlier installs (or operators who hand-edited
// runtime-config.json) could ship without an explicit value. On first
// load with such a config we now apply the secure default AND record this
// event so the operator can see why their previously-plaintext output is
// suddenly being scrubbed.
//
// The detail string includes which keys were defaulted, so an operator
// reading the audit log can opt back out with a precise explicit-false
// override (`redactToolOutput: false`) for any flow that genuinely needs
// raw bytes (e.g. binary patch tooling where the redactor's string match
// would corrupt the patch).
// ---------------------------------------------------------------------------

export interface RedactionDefaultAppliedPayload {
  /** Keys that were missing from the loaded config and received the secure default. */
  appliedKeys: ReadonlyArray<string>;
  /** Provenance fields surfaced into the audit row. */
  sessionId?: string;
  agentId?: string;
  presetId?: string;
}

export function recordRedactionDefaultApplied(
  log: SecurityAuditLog,
  payload: RedactionDefaultAppliedPayload,
): void {
  const keys = payload.appliedKeys.length > 0 ? payload.appliedKeys.join(', ') : '(none)';
  log.record({
    type: 'security:redaction_default_applied',
    severity: 'info',
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.presetId ? { presetId: payload.presetId } : {}),
    detail:
      `Secure default applied for missing security policy key(s): [${keys}]. ` +
      `Set the key explicitly in runtime-config.json to silence this event. ` +
      `Note: redactToolOutput may corrupt patch-tool outputs that embed key-shaped substrings; ` +
      `opt out per-deployment if needed.`,
  });
}
