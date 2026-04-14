import { describe, it, expect } from 'vitest';
import { scoreComplexity, selectModelForComplexity } from '../packages/core/src/index.js';

describe('scoreComplexity', () => {
  it('short greeting scores as simple', () => {
    const result = scoreComplexity('hello', 0);
    expect(result.level).toBe('simple');
    expect(result.score).toBeLessThan(0.25);
  });

  it('short question scores as simple', () => {
    const result = scoreComplexity('what time is it?', 0);
    expect(result.level).toBe('simple');
  });

  it('multi-step request with "then" / "after that" scores as moderate or complex', () => {
    const message = 'First implement the login form, then add validation, after that write tests for it';
    const result = scoreComplexity(message, 0);
    // Multi-step indicators: first, then, after that + code keywords: implement, function, test
    expect(['moderate', 'complex']).toContain(result.level);
    expect(result.score).toBeGreaterThanOrEqual(0.25);
    expect(result.reason).toContain('multi-step indicators');
  });

  it('code keywords (implement, function, debug) increase complexity', () => {
    // Pack enough signals to push past the complex threshold:
    // complexity markers: implement, debug, optimize, analyze, refactor
    // code keywords: function, module, database, query, api
    // medium-length message + tool count boost
    const result = scoreComplexity(
      'analyze and implement a function to debug and refactor the authentication module, then optimize the database query and design a new api endpoint',
      10,
    );
    expect(result.level).toBe('complex');
    expect(result.reason).toContain('code keywords');
    expect(result.reason).toContain('complexity markers');
  });

  it('simple factual question scores as simple or moderate', () => {
    const result = scoreComplexity('What is the capital of France?', 0);
    expect(['simple', 'moderate']).toContain(result.level);
    expect(result.score).toBeLessThan(0.55);
  });

  it('multiple questions increase complexity score', () => {
    const result = scoreComplexity('What is TypeScript? How does it compare to JavaScript? Which should I use?', 0);
    expect(result.reason).toContain('multiple questions');
    expect(result.score).toBeGreaterThan(0);
  });

  it('tool count above 5 adds a small score boost', () => {
    const withoutTools = scoreComplexity('hello world', 0);
    const withTools = scoreComplexity('hello world', 10);
    expect(withTools.score).toBeGreaterThan(withoutTools.score);
    expect(withTools.reason).toContain('tools available');
  });

  it('long messages increase complexity', () => {
    // Generate a message with more than 100 words
    const longMessage = Array(120).fill('word').join(' ');
    const result = scoreComplexity(longMessage, 0);
    expect(result.reason).toContain('long message');
    expect(result.score).toBeGreaterThan(0);
  });

  it('score is clamped between 0 and 1', () => {
    // Pack every possible signal to try to exceed 1.0
    const maxMessage = 'first then after that also next additionally followed by step by step second finally '
      + 'analyze compare implement refactor debug optimize architect design evaluate investigate '
      + 'code function class module api endpoint database query algorithm typescript javascript python? '
      + 'another question? and more? ' + 'padding '.repeat(100);
    const result = scoreComplexity(maxMessage, 20);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe('selectModelForComplexity', () => {
  it('routes simple complexity to fastModel', () => {
    const complexity = { level: 'simple' as const, score: 0.1, reason: 'short message' };
    const model = selectModelForComplexity(complexity, 'claude-opus-4', 'claude-haiku');
    expect(model).toBe('claude-haiku');
  });

  it('routes moderate complexity to primaryModel', () => {
    const complexity = { level: 'moderate' as const, score: 0.4, reason: 'medium-length message' };
    const model = selectModelForComplexity(complexity, 'claude-opus-4', 'claude-haiku');
    expect(model).toBe('claude-opus-4');
  });

  it('routes complex to primaryModel', () => {
    const complexity = { level: 'complex' as const, score: 0.8, reason: 'multi-step indicators' };
    const model = selectModelForComplexity(complexity, 'claude-opus-4', 'claude-haiku');
    expect(model).toBe('claude-opus-4');
  });

  it('returns primaryModel when no fastModel is configured', () => {
    const simpleComplexity = { level: 'simple' as const, score: 0.05, reason: 'short message' };
    const model = selectModelForComplexity(simpleComplexity, 'claude-opus-4');
    expect(model).toBe('claude-opus-4');
  });

  it('returns primaryModel when fastModel is undefined', () => {
    const simpleComplexity = { level: 'simple' as const, score: 0.1, reason: 'test' };
    const model = selectModelForComplexity(simpleComplexity, 'gpt-4o', undefined);
    expect(model).toBe('gpt-4o');
  });
});
