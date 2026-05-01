/**
 * Tests for the SKILL.md parser, validator, and activation gates.
 * Covers both legacy CrowClaw skills and agentskills.io v1.0 format.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSkillFile,
  renderSkillFile,
  validateSkillManifest,
  checkSkillGates,
  filterAndBudgetSkills,
  matchSkillManifests,
} from '../packages/core/src/skill-manifest.js';

// --- Phase B fixtures -------------------------------------------------------

const LEGACY_SKILL = `---
name: deploy-vercel
description: Deploy a web app to Vercel
triggers:
  - deploy to vercel
  - vercel deploy
tools:
  - terminal.exec
  - web.fetch
category: deployment
---

# Deploy to Vercel

1. Run \`vercel deploy --prod\`
`;

const NEW_FORMAT_SKILL = `---
name: deploy-vercel
description: Deploy a web app to Vercel
version: 1.2.0
author: ada@example.com
license: MIT
categories:
  - deployment
  - web
platforms:
  - darwin
  - linux
triggers:
  - deploy to vercel
config_requirements:
  env:
    - VERCEL_TOKEN
  tools:
    - terminal.exec
  mcpServers:
    - vercel-mcp
updated_at: 2026-04-12T09:30:00Z
---

# Deploy to Vercel

1. Run \`vercel deploy --prod\`
`;

const NO_FRONTMATTER = `# Just a markdown file\n\nNo frontmatter here.\n`;

// 3 hand-crafted spec-compliant fixtures (representing real published skills)

const FIXTURE_PR_REVIEW = `---
name: pr-review
description: Review a GitHub pull request and post inline comments
version: 0.4.1
author: hermes-community
license: Apache-2.0
categories:
  - github
  - code-review
triggers:
  - review this PR
  - check this pull request
config_requirements:
  env:
    - GITHUB_TOKEN
  tools:
    - github.pr.list
    - github.pr.comment
---

# PR Review

1. Fetch the PR diff
2. Identify risky patterns
3. Post inline review comments
`;

const FIXTURE_KUBERNETES_TRIAGE = `---
name: k8s-triage
description: Diagnose a failing Kubernetes deployment
version: 2.0.0
license: MIT
categories:
  - devops
  - kubernetes
platforms:
  - linux
  - darwin
triggers:
  - pod is crashing
  - k8s deployment broken
config_requirements:
  tools:
    - terminal.exec
  env:
    - KUBECONFIG
---

# Kubernetes Triage

1. \`kubectl get pods\`
2. Inspect events and logs
3. Suggest a fix
`;

const FIXTURE_DOCS_WRITER = `---
name: docs-writer
description: Generate API reference documentation from source comments
version: 1.0.0
author: docops@example.org
license: BSD-3-Clause
categories:
  - documentation
triggers:
  - generate docs
  - write API reference
---

# Docs Writer

1. Read the relevant source files
2. Extract JSDoc-style comments
3. Render as markdown
`;

// --- Parsing ---------------------------------------------------------------

describe('parseSkillFile — legacy + new format', () => {
  it('parses a legacy skill (no version/license) and applies defaults', () => {
    const parsed = parseSkillFile(LEGACY_SKILL);
    expect(parsed).not.toBeNull();
    expect(parsed!.manifest.name).toBe('deploy-vercel');
    expect(parsed!.manifest.version).toBe('0.0.0'); // default
    expect(parsed!.manifest.license).toBe('UNLICENSED'); // default
    expect(parsed!.manifest.categories).toEqual(['deployment']); // folded from `category`
    expect(parsed!.manifest.platforms).toBeUndefined();
    expect(parsed!.manifest.config_requirements).toBeUndefined();
    expect(parsed!.manifest.triggers).toEqual(['deploy to vercel', 'vercel deploy']);
    expect(parsed!.manifest.tools).toEqual(['terminal.exec', 'web.fetch']);
  });

  it('parses a full agentskills.io v1.0 skill', () => {
    const parsed = parseSkillFile(NEW_FORMAT_SKILL);
    expect(parsed).not.toBeNull();
    expect(parsed!.manifest.version).toBe('1.2.0');
    expect(parsed!.manifest.author).toBe('ada@example.com');
    expect(parsed!.manifest.license).toBe('MIT');
    expect(parsed!.manifest.categories).toEqual(['deployment', 'web']);
    expect(parsed!.manifest.platforms).toEqual(['darwin', 'linux']);
    expect(parsed!.manifest.config_requirements).toEqual({
      env: ['VERCEL_TOKEN'],
      tools: ['terminal.exec'],
      mcpServers: ['vercel-mcp'],
    });
    expect(parsed!.manifest.updated_at).toBe('2026-04-12T09:30:00Z');
    expect(parsed!.instructions).toContain('# Deploy to Vercel');
  });

  it('returns null for files without YAML frontmatter', () => {
    expect(parseSkillFile(NO_FRONTMATTER)).toBeNull();
  });

  it('returns null when name is missing', () => {
    const noName = `---\ndescription: Missing name\ntriggers:\n  - x\n---\n# body`;
    expect(parseSkillFile(noName)).toBeNull();
  });
});

describe('parseSkillFile — published skill fixtures (3 spec-compliant samples)', () => {
  it('parses pr-review fixture', () => {
    const parsed = parseSkillFile(FIXTURE_PR_REVIEW);
    expect(parsed).not.toBeNull();
    expect(parsed!.manifest.name).toBe('pr-review');
    expect(parsed!.manifest.version).toBe('0.4.1');
    expect(parsed!.manifest.license).toBe('Apache-2.0');
    expect(parsed!.manifest.categories).toEqual(['github', 'code-review']);
    expect(parsed!.manifest.config_requirements?.env).toEqual(['GITHUB_TOKEN']);
    expect(parsed!.manifest.config_requirements?.tools).toEqual([
      'github.pr.list',
      'github.pr.comment',
    ]);
  });

  it('parses k8s-triage fixture with platforms', () => {
    const parsed = parseSkillFile(FIXTURE_KUBERNETES_TRIAGE);
    expect(parsed).not.toBeNull();
    expect(parsed!.manifest.platforms).toEqual(['linux', 'darwin']);
    expect(parsed!.manifest.config_requirements?.env).toEqual(['KUBECONFIG']);
  });

  it('parses docs-writer fixture (minimal config_requirements omitted)', () => {
    const parsed = parseSkillFile(FIXTURE_DOCS_WRITER);
    expect(parsed).not.toBeNull();
    expect(parsed!.manifest.author).toBe('docops@example.org');
    expect(parsed!.manifest.config_requirements).toBeUndefined();
    expect(parsed!.manifest.platforms).toBeUndefined();
  });
});

// --- Validation ------------------------------------------------------------

describe('validateSkillManifest', () => {
  it('accepts a complete agentskills.io manifest', () => {
    const parsed = parseSkillFile(NEW_FORMAT_SKILL)!;
    const result = validateSkillManifest(parsed.manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects manifest missing name', () => {
    const result = validateSkillManifest({
      description: 'x',
      triggers: ['t'],
    } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('rejects manifest missing description', () => {
    const result = validateSkillManifest({
      name: 'x',
      triggers: ['t'],
    } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('rejects manifest with empty triggers', () => {
    const result = validateSkillManifest({
      name: 'x',
      description: 'd',
      triggers: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('triggers'))).toBe(true);
  });

  it('rejects malformed config_requirements', () => {
    const result = validateSkillManifest({
      name: 'x',
      description: 'd',
      triggers: ['t'],
      config_requirements: { env: 'not-an-array' as never },
    });
    expect(result.valid).toBe(false);
  });

  it('warns on non-kebab-case names but stays valid', () => {
    const result = validateSkillManifest({
      name: 'Bad Name With Spaces',
      description: 'd',
      triggers: ['t'],
    });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// --- Activation gates ------------------------------------------------------

describe('checkSkillGates — platforms', () => {
  it('skips a darwin-only skill on linux', () => {
    const parsed = parseSkillFile(`---
name: mac-only
description: macOS-only skill
triggers: [foo]
platforms:
  - darwin
---
# body`)!;
    const gate = checkSkillGates(parsed, { platform: 'linux' });
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/Platform/);
  });

  it('allows a multi-platform skill on a matching platform', () => {
    const parsed = parseSkillFile(`---
name: cross
description: cross-plat
triggers: [foo]
platforms:
  - darwin
  - linux
---
# body`)!;
    expect(checkSkillGates(parsed, { platform: 'darwin' }).eligible).toBe(true);
    expect(checkSkillGates(parsed, { platform: 'linux' }).eligible).toBe(true);
    expect(checkSkillGates(parsed, { platform: 'win32' }).eligible).toBe(false);
  });

  it('allows skills without a platforms field on any platform', () => {
    const parsed = parseSkillFile(LEGACY_SKILL)!;
    expect(checkSkillGates(parsed, { platform: 'win32' }).eligible).toBe(true);
  });
});

describe('checkSkillGates — config_requirements', () => {
  it('skips when a required env var is missing (with reason)', () => {
    const parsed = parseSkillFile(NEW_FORMAT_SKILL)!;
    const gate = checkSkillGates(parsed, {
      platform: 'darwin',
      envVars: {}, // VERCEL_TOKEN missing
      availableToolNames: ['terminal.exec'],
      availableMcpServers: ['vercel-mcp'],
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/VERCEL_TOKEN/);
  });

  it('passes when all config_requirements are met', () => {
    const parsed = parseSkillFile(NEW_FORMAT_SKILL)!;
    const gate = checkSkillGates(parsed, {
      platform: 'darwin',
      envVars: { VERCEL_TOKEN: 'sk_xxx' },
      availableToolNames: ['terminal.exec'],
      availableMcpServers: ['vercel-mcp'],
    });
    expect(gate.eligible).toBe(true);
  });

  it('skips when a required MCP server is missing', () => {
    const parsed = parseSkillFile(NEW_FORMAT_SKILL)!;
    const gate = checkSkillGates(parsed, {
      platform: 'darwin',
      envVars: { VERCEL_TOKEN: 'sk_xxx' },
      availableToolNames: ['terminal.exec'],
      availableMcpServers: [],
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/MCP/);
  });

  it('skips when a required tool is missing', () => {
    const parsed = parseSkillFile(NEW_FORMAT_SKILL)!;
    const gate = checkSkillGates(parsed, {
      platform: 'darwin',
      envVars: { VERCEL_TOKEN: 'sk_xxx' },
      availableToolNames: [], // terminal.exec missing
      availableMcpServers: ['vercel-mcp'],
    });
    expect(gate.eligible).toBe(false);
  });
});

describe('filterAndBudgetSkills — agentskills.io aware', () => {
  it('filters out skills that fail platform/env gates', () => {
    const macOnly = parseSkillFile(`---
name: mac-only
description: x
triggers: [t]
platforms: [darwin]
---
# body`)!;
    const universal = parseSkillFile(LEGACY_SKILL)!;
    const filtered = filterAndBudgetSkills([macOnly, universal], {
      platform: 'linux',
    });
    expect(filtered.map((s) => s.manifest.name)).toEqual(['deploy-vercel']);
  });
});

// --- Match (regression: algorithm UNCHANGED) -------------------------------

describe('matchSkillManifests — regression (algorithm must remain stable)', () => {
  it('matches by trigger phrase even with the new fields present', () => {
    const skills = [parseSkillFile(NEW_FORMAT_SKILL)!];
    const matches = matchSkillManifests('please deploy to vercel now', skills);
    expect(matches.length).toBe(1);
    expect(matches[0]!.skill.manifest.name).toBe('deploy-vercel');
    expect(matches[0]!.score).toBeGreaterThan(0);
  });
});

// --- Render round-trip -----------------------------------------------------

describe('renderSkillFile + parseSkillFile round-trip', () => {
  it('round-trips a full new-format manifest', () => {
    const parsed = parseSkillFile(NEW_FORMAT_SKILL)!;
    const rendered = renderSkillFile(parsed.manifest, parsed.instructions);
    const reparsed = parseSkillFile(rendered);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.manifest.name).toBe(parsed.manifest.name);
    expect(reparsed!.manifest.version).toBe(parsed.manifest.version);
    expect(reparsed!.manifest.platforms).toEqual(parsed.manifest.platforms);
    expect(reparsed!.manifest.config_requirements?.env).toEqual(
      parsed.manifest.config_requirements?.env
    );
  });
});
