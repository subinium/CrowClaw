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

// ---------------------------------------------------------------------------
// Credential Redaction
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'openai_key', pattern: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'anthropic_key', pattern: /sk-ant-[a-zA-Z0-9-]{20,}/g },
  { name: 'github_token_ghp', pattern: /ghp_[a-zA-Z0-9]{36}/g },
  { name: 'github_token_gho', pattern: /gho_[a-zA-Z0-9]{36}/g },
  { name: 'github_token_ghs', pattern: /ghs_[a-zA-Z0-9]{36}/g },
  { name: 'github_pat', pattern: /github_pat_[a-zA-Z0-9_]{20,}/g },
  { name: 'slack_token', pattern: /xox[bpar]-[a-zA-Z0-9-]+/g },
  { name: 'aws_key', pattern: /AKIA[A-Z0-9]{16}/g },
  { name: 'bearer_token', pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g },
  { name: 'generic_credential', pattern: /[a-zA-Z_]{0,30}(?:key|token|secret|password|credential)[a-zA-Z_]{0,30}\s{0,5}[:=]\s{0,5}["'][^"']{8,80}["']/gi },
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
  | 'approval_required'
  | 'approval_denied';

export type SecurityEventSeverity = 'info' | 'warning' | 'critical';

export interface SecurityEvent {
  timestamp: string;
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  detail: string;
  sessionId?: string;
}

export class SecurityAuditLog {
  private events: SecurityEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents = 500) {
    this.maxEvents = maxEvents;
  }

  record(event: Omit<SecurityEvent, 'timestamp'>): void {
    const entry: SecurityEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
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
}
