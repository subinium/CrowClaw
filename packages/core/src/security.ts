// ---------------------------------------------------------------------------
// URL Safety — SSRF protection
// ---------------------------------------------------------------------------

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fe80:/i,
  /^::1$/,
  /^localhost$/i,
  /^.*\.local$/i,
  /^.*\.internal$/i
];

export function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    return PRIVATE_IP_PATTERNS.some(p => p.test(hostname));
  } catch {
    return true; // invalid URLs are treated as private
  }
}

export function validateFetchUrl(url: string): { safe: boolean; reason?: string } {
  if (!url) return { safe: false, reason: 'Empty URL' };

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
    }
    if (isPrivateUrl(url)) {
      return { safe: false, reason: 'URL resolves to private/internal network' };
    }
    return { safe: true };
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
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
