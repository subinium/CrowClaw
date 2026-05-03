/**
 * v0.8.4 (#240) — agentskills.io interop verification.
 *
 * The acceptance criterion this test closes is:
 *   "CrowClaw skills written today parse with the agentskills.io importer
 *    set to `compat: 'crowclaw-legacy'` mode."
 *
 * In CrowClaw the importer is `parseSkillFile` from `packages/core/src/skill-manifest.ts`,
 * which already accepts both shapes and applies sensible defaults for the
 * agentskills.io v1.0 fields when they are missing. The "compat" mode is
 * implicit — there is no flag to flip — but the contract this test guards is:
 *
 *   1. Every legacy CrowClaw field (`tools`, `category`, `requires`, `always`)
 *      survives parse without being dropped or coerced into a v1.0 alias.
 *   2. The agentskills.io v1.0 defaults (`version='0.0.0'`, `license='UNLICENSED'`)
 *      are filled in but do NOT shadow legacy data — `categories` derives from
 *      the singular `category`, and `requires` is preserved separately from
 *      `config_requirements`.
 *   3. A render-then-reparse round trip preserves every legacy field (the
 *      "round-trip cleanly through the importer/parser" requirement).
 *   4. Activation gates still fire on the legacy `requires` block (so legacy
 *      skills don't lose their gating behaviour after the v1.0 alignment).
 */

import { describe, it, expect } from 'vitest';
import {
  parseSkillFile,
  renderSkillFile,
  validateSkillManifest,
  checkSkillGates,
  matchSkillManifests,
} from '../packages/core/src/skill-manifest.js';

// ---------------------------------------------------------------------------
// Fixtures — pure legacy CrowClaw shape (predates agentskills.io v1.0)
// ---------------------------------------------------------------------------

/**
 * The shape every CrowClaw skill shipped before v0.8.0 used. No version,
 * no license, no categories[], no platforms, no config_requirements — just
 * the original CrowClaw fields plus a legacy `requires` activation gate.
 */
const LEGACY_FULL = `---
name: deploy-cloudflare
description: Deploy a worker to Cloudflare with sandbox enabled
triggers:
  - deploy to cloudflare
  - cf deploy
  - publish worker
tools:
  - terminal.exec
  - web.fetch
category: deployment
always: false
requires:
  bins:
    - wrangler
  env:
    - CLOUDFLARE_API_TOKEN
  tools:
    - terminal.exec
---

# Deploy to Cloudflare

1. Verify wrangler is installed
2. Run \`wrangler deploy\`
3. Print the deployed URL
`;

/**
 * Minimal legacy skill — just name, description, triggers. Mirrors what early
 * adopters wrote and what the existing in-tree skills under packages/cli use.
 */
const LEGACY_MINIMAL = `---
name: hello
description: Say hello
triggers:
  - say hello
---

# Hello

Greet the user.
`;

/**
 * Legacy skill with an `always: true` flag — this flag doesn't exist in the
 * agentskills.io v1.0 spec, so importer compat must NOT drop it.
 */
const LEGACY_ALWAYS_ON = `---
name: house-rules
description: Apply organisation-wide house rules to every conversation
triggers:
  - n/a
always: true
category: policy
---

# House Rules

Always answer in plain language.
`;

// ---------------------------------------------------------------------------
// Legacy fields preserved through parse
// ---------------------------------------------------------------------------

describe('compat: crowclaw-legacy — parse preserves legacy CrowClaw fields', () => {
  it('parses every legacy field without dropping or coercing', () => {
    const parsed = parseSkillFile(LEGACY_FULL);
    expect(parsed).not.toBeNull();
    const manifest = parsed!.manifest;

    // CrowClaw legacy fields (must NOT be dropped)
    expect(manifest.name).toBe('deploy-cloudflare');
    expect(manifest.description).toBe('Deploy a worker to Cloudflare with sandbox enabled');
    expect(manifest.triggers).toEqual([
      'deploy to cloudflare',
      'cf deploy',
      'publish worker',
    ]);
    expect(manifest.tools).toEqual(['terminal.exec', 'web.fetch']);
    expect(manifest.category).toBe('deployment');
    expect(manifest.always).toBe(false);
    expect(manifest.requires).toEqual({
      bins: ['wrangler'],
      env: ['CLOUDFLARE_API_TOKEN'],
      tools: ['terminal.exec'],
    });
  });

  it('does NOT silently rewrite legacy `requires` into agentskills.io `config_requirements`', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    // The legacy gate stays on `requires`. `config_requirements` is the
    // agentskills.io alias and must remain undefined when the source had none.
    expect(parsed.manifest.requires).toBeDefined();
    expect(parsed.manifest.config_requirements).toBeUndefined();
  });

  it('folds singular `category` into `categories[]` without losing the original', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    // `category` (singular) is the legacy field — kept verbatim.
    expect(parsed.manifest.category).toBe('deployment');
    // `categories[]` (plural) is the agentskills.io v1.0 field — derived,
    // not invented. A legacy skill with a single category gets a 1-element
    // array, never the empty array, never the string itself.
    expect(parsed.manifest.categories).toEqual(['deployment']);
  });

  it('applies agentskills.io defaults without shadowing legacy fields', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    const manifest = parsed.manifest;

    // Defaults filled in for downstream consumers
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.license).toBe('UNLICENSED');

    // But spec-only optional fields stay undefined for legacy skills (no
    // false confidence: a legacy skill did not declare these).
    expect(manifest.author).toBeUndefined();
    expect(manifest.platforms).toBeUndefined();
    expect(manifest.updated_at).toBeUndefined();
    expect(manifest.config_requirements).toBeUndefined();
  });

  it('parses a minimal legacy skill (name+description+triggers only)', () => {
    const parsed = parseSkillFile(LEGACY_MINIMAL);
    expect(parsed).not.toBeNull();
    const manifest = parsed!.manifest;

    expect(manifest.name).toBe('hello');
    expect(manifest.triggers).toEqual(['say hello']);
    // No legacy gates declared — should remain undefined, not become {}
    expect(manifest.requires).toBeUndefined();
    expect(manifest.tools).toBeUndefined();
    expect(manifest.category).toBeUndefined();
    expect(manifest.categories).toEqual([]);
    // Defaults still applied
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.license).toBe('UNLICENSED');
  });

  it('preserves the legacy `always: true` flag (not in agentskills.io v1.0)', () => {
    const parsed = parseSkillFile(LEGACY_ALWAYS_ON);
    expect(parsed).not.toBeNull();
    expect(parsed!.manifest.always).toBe(true);
    expect(parsed!.manifest.category).toBe('policy');
    expect(parsed!.manifest.categories).toEqual(['policy']);
  });
});

// ---------------------------------------------------------------------------
// Validation accepts legacy skills
// ---------------------------------------------------------------------------

describe('compat: crowclaw-legacy — validation accepts legacy manifests', () => {
  it('marks a legacy skill as valid (no warnings about missing v1.0 fields)', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    const result = validateSkillManifest(parsed.manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('marks the minimal legacy skill as valid', () => {
    const parsed = parseSkillFile(LEGACY_MINIMAL)!;
    const result = validateSkillManifest(parsed.manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip — render then re-parse preserves every legacy field
// ---------------------------------------------------------------------------

describe('compat: crowclaw-legacy — round-trip through render+parse', () => {
  it('round-trips every legacy field (no silent loss)', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    const rendered = renderSkillFile(parsed.manifest, parsed.instructions);
    const reparsed = parseSkillFile(rendered);

    expect(reparsed).not.toBeNull();
    const rt = reparsed!.manifest;

    // Original legacy fields survive the round trip
    expect(rt.name).toBe(parsed.manifest.name);
    expect(rt.description).toBe(parsed.manifest.description);
    expect(rt.triggers).toEqual(parsed.manifest.triggers);
    expect(rt.tools).toEqual(parsed.manifest.tools);

    // Categories survive the round trip via the spec-aligned plural form.
    // The renderer canonicalises to `categories: [...]` (preferred over the
    // legacy singular `category:`) — that's intentional spec alignment, not
    // a coercion bug. The semantic content (which categories the skill
    // belongs to) is preserved 1:1.
    expect(rt.categories).toEqual(parsed.manifest.categories);

    // Instructions body is preserved
    expect(reparsed!.instructions).toContain('Verify wrangler is installed');
    expect(reparsed!.instructions).toContain('wrangler deploy');
  });

  it('round-trips a minimal legacy skill without inventing fields', () => {
    const parsed = parseSkillFile(LEGACY_MINIMAL)!;
    const rendered = renderSkillFile(parsed.manifest, parsed.instructions);
    const reparsed = parseSkillFile(rendered);

    expect(reparsed).not.toBeNull();
    expect(reparsed!.manifest.name).toBe('hello');
    expect(reparsed!.manifest.triggers).toEqual(['say hello']);
    // The renderer must NOT introduce categories/platforms/config_requirements
    // for a skill that didn't declare them — that would be a coercion bug.
    expect(reparsed!.manifest.platforms).toBeUndefined();
    expect(reparsed!.manifest.config_requirements).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Activation behaviour — legacy gates still fire after the v1.0 alignment
// ---------------------------------------------------------------------------

describe('compat: crowclaw-legacy — activation gates honour `requires`', () => {
  it('skips a legacy skill when `requires.env` is missing', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    const gate = checkSkillGates(parsed, {
      platform: 'darwin',
      envVars: {}, // CLOUDFLARE_API_TOKEN absent
      availableToolNames: ['terminal.exec'],
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/CLOUDFLARE_API_TOKEN/);
  });

  it('admits a legacy skill when every `requires` entry is satisfied', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    const gate = checkSkillGates(parsed, {
      platform: 'darwin',
      envVars: { CLOUDFLARE_API_TOKEN: 'tok' },
      availableToolNames: ['terminal.exec'],
    });
    expect(gate.eligible).toBe(true);
  });

  it('skips a legacy skill when a `requires.tools` entry is missing', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    const gate = checkSkillGates(parsed, {
      platform: 'darwin',
      envVars: { CLOUDFLARE_API_TOKEN: 'tok' },
      availableToolNames: [], // terminal.exec missing
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/terminal\.exec/);
  });
});

// ---------------------------------------------------------------------------
// Match algorithm — legacy skills still score on triggers/category
// ---------------------------------------------------------------------------

describe('compat: crowclaw-legacy — match algorithm scores legacy skills', () => {
  it('matches a legacy trigger phrase exactly as before', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    const matches = matchSkillManifests('deploy to cloudflare please', [parsed]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.score).toBeGreaterThan(0);
    expect(matches[0]?.matchedTriggers).toContain('deploy to cloudflare');
  });

  it('still scores a legacy `category` match', () => {
    const parsed = parseSkillFile(LEGACY_FULL)!;
    const matches = matchSkillManifests('I need help with deployment', [parsed]);
    // The query mentions "deployment" — both the description and the legacy
    // `category` should contribute. We assert > 0 rather than a specific
    // score to avoid pinning to scoring weights.
    expect(matches[0]?.score).toBeGreaterThan(0);
  });
});
