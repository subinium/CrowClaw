/**
 * Routes queries to appropriate models based on estimated complexity.
 * Simple queries (greetings, short factual) -> fast/cheap model
 * Complex queries (multi-step, code, analysis) -> primary model
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

export interface ComplexityScore {
  level: ComplexityLevel;
  score: number; // 0-1
  reason: string;
}

// ---------------------------------------------------------------------------
// Heuristic constants
// ---------------------------------------------------------------------------

const MULTI_STEP_INDICATORS = [
  'then',
  'after that',
  'also',
  'next',
  'additionally',
  'followed by',
  'step by step',
  'first',
  'second',
  'finally',
];

const COMPLEXITY_KEYWORDS = [
  'analyze',
  'compare',
  'implement',
  'refactor',
  'debug',
  'optimize',
  'architect',
  'design',
  'evaluate',
  'investigate',
  'diagnose',
  'migrate',
  'benchmark',
];

const CODE_KEYWORDS = [
  'code',
  'function',
  'class',
  'module',
  'api',
  'endpoint',
  'database',
  'query',
  'algorithm',
  'typescript',
  'javascript',
  'python',
  'rust',
  'component',
  'test',
];

const SHORT_MESSAGE_THRESHOLD = 20;
const MODERATE_MESSAGE_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Estimate the complexity of a user message using lightweight heuristics.
 *
 * Heuristics considered:
 * - Message length (short = simple)
 * - Question marks and multi-step indicators ("then", "after that", "also")
 * - Code-related keywords
 * - Tool count available (more tools = potentially complex)
 * - Explicit complexity markers ("analyze", "compare", "implement")
 */
export function scoreComplexity(userMessage: string, toolCount: number): ComplexityScore {
  let score = 0;
  const reasons: string[] = [];

  const lowerMessage = userMessage.toLowerCase();
  const wordCount = userMessage.split(/\s+/).filter(Boolean).length;

  // 1. Message length
  if (wordCount <= SHORT_MESSAGE_THRESHOLD) {
    // Short messages lean simple
    score += 0.0;
  } else if (wordCount <= MODERATE_MESSAGE_THRESHOLD) {
    score += 0.15;
    reasons.push('medium-length message');
  } else {
    score += 0.3;
    reasons.push('long message');
  }

  // 2. Question complexity
  const questionMarkCount = (userMessage.match(/\?/g) ?? []).length;
  if (questionMarkCount > 1) {
    score += 0.15;
    reasons.push('multiple questions');
  }

  // 3. Multi-step indicators
  const multiStepHits = MULTI_STEP_INDICATORS.filter((indicator) =>
    lowerMessage.includes(indicator)
  );
  if (multiStepHits.length > 0) {
    score += Math.min(0.25, multiStepHits.length * 0.08);
    reasons.push(`multi-step indicators: ${multiStepHits.join(', ')}`);
  }

  // 4. Code-related keywords
  const codeHits = CODE_KEYWORDS.filter((kw) => lowerMessage.includes(kw));
  if (codeHits.length > 0) {
    score += Math.min(0.2, codeHits.length * 0.05);
    reasons.push(`code keywords: ${codeHits.join(', ')}`);
  }

  // 5. Explicit complexity markers
  const complexityHits = COMPLEXITY_KEYWORDS.filter((kw) => lowerMessage.includes(kw));
  if (complexityHits.length > 0) {
    score += Math.min(0.25, complexityHits.length * 0.1);
    reasons.push(`complexity markers: ${complexityHits.join(', ')}`);
  }

  // 6. Tool count influence
  if (toolCount > 5) {
    score += 0.05;
    reasons.push(`${toolCount} tools available`);
  }

  // Clamp to [0, 1]
  score = Math.min(1, Math.max(0, score));

  // Determine level
  let level: ComplexityLevel;
  if (score < 0.25) {
    level = 'simple';
  } else if (score < 0.55) {
    level = 'moderate';
  } else {
    level = 'complex';
  }

  const reason = reasons.length > 0 ? reasons.join('; ') : 'short/simple message';

  return { level, score: Math.round(score * 100) / 100, reason };
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * Select the appropriate model based on complexity score.
 * Falls back to primaryModel when no fastModel is configured.
 */
export function selectModelForComplexity(
  complexity: ComplexityScore,
  primaryModel: string,
  fastModel?: string,
): string {
  if (!fastModel) return primaryModel;
  return complexity.level === 'simple' ? fastModel : primaryModel;
}
