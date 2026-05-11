// v0.9.0 (#329) — `[[as_document]]` skill-directive parser. Acceptance:
//   - Skill with `[[as_document]]` triggers document delivery
//   - Channels without document support fall back inline (Agent B owns
//     that branch; here we just verify the directive lands on the message)
//   - Inline default for non-marked skills
//
// Front-matter form (`as_document: true` or `delivery_mode: document`) is
// also tested — Hermes shipped both forms; we match.

import { describe, it, expect } from 'vitest';
import { parseSkillFile } from '@crowclaw/core';
import {
  detectSkillDeliveryDirective,
  applyDeliveryDirective,
} from '@crowclaw/tools';

const FRONT = (yaml: string, body: string): string => `---\n${yaml}\n---\n${body}\n`;

describe('skill [[as_document]] directive (#329)', () => {
  it('defaults to inline when no directive is present', () => {
    const parsed = parseSkillFile(FRONT(
      'name: plain-skill\ndescription: hi\ntriggers: [hello]',
      'Just a regular skill body.',
    ));
    expect(parsed).not.toBeNull();
    const directive = detectSkillDeliveryDirective(parsed!);
    expect(directive.deliveryMode).toBe('inline');
    expect(directive.source).toBe('none');
    expect(directive.filename).toBeUndefined();
  });

  it('detects inline body marker [[as_document]]', () => {
    const parsed = parseSkillFile(FRONT(
      'name: long-report\ndescription: long\ntriggers: [report]',
      'Renders a long markdown report.\n\n[[as_document]]\n',
    ));
    const directive = detectSkillDeliveryDirective(parsed!);
    expect(directive.deliveryMode).toBe('document');
    expect(directive.source).toBe('body');
    expect(directive.filename).toBe('long-report.md');
    expect(directive.mime).toBe('text/markdown; charset=utf-8');
  });

  it('detects front-matter as_document: true', () => {
    const parsed = parseSkillFile(FRONT(
      'name: exec-deck\ndescription: deck\ntriggers: [deck]\nas_document: true',
      'Slide deck content...',
    ));
    const directive = detectSkillDeliveryDirective(parsed!);
    expect(directive.deliveryMode).toBe('document');
    expect(directive.source).toBe('frontmatter');
    expect(directive.filename).toBe('exec-deck.md');
  });

  it('detects front-matter delivery_mode: document', () => {
    const parsed = parseSkillFile(FRONT(
      'name: code-dump\ndescription: dump\ntriggers: [dump]\ndelivery_mode: document',
      'Big code dump.',
    ));
    const directive = detectSkillDeliveryDirective(parsed!);
    expect(directive.deliveryMode).toBe('document');
    expect(directive.source).toBe('frontmatter');
  });

  it('front-matter overrides body marker (explicit inline wins)', () => {
    // Useful when a skill author wants to force inline even though an
    // included shared section has the body marker.
    const parsed = parseSkillFile(FRONT(
      'name: chatty\ndescription: chat\ntriggers: [chat]\ndelivery_mode: inline',
      'Some chat instructions.\n[[as_document]]\n',
    ));
    const directive = detectSkillDeliveryDirective(parsed!);
    expect(directive.deliveryMode).toBe('inline');
    expect(directive.source).toBe('frontmatter');
  });

  it('case-insensitive inline marker', () => {
    const parsed = parseSkillFile(FRONT(
      'name: weird\ndescription: x\ntriggers: [x]',
      'Body.\n\n[[ AS_DOCUMENT ]]\n',
    ));
    const directive = detectSkillDeliveryDirective(parsed!);
    expect(directive.deliveryMode).toBe('document');
  });

  it('does not match incidental similar text', () => {
    // The directive is `[[as_document]]` — text describing the feature
    // should not flip the mode.
    const parsed = parseSkillFile(FRONT(
      'name: docs\ndescription: x\ntriggers: [x]',
      'Set `as_document` in front-matter to opt in. Or use [[ tool.list ]] for tools.',
    ));
    const directive = detectSkillDeliveryDirective(parsed!);
    expect(directive.deliveryMode).toBe('inline');
  });

  it('filename sanitizes non-slug characters', () => {
    // Skill names should already be slugs (validateSkillManifest warns
    // otherwise) but we still defend against weird names.
    const parsed = parseSkillFile(FRONT(
      'name: weird/skill name\ndescription: x\ntriggers: [x]\nas_document: true',
      'body',
    ));
    const directive = detectSkillDeliveryDirective(parsed!);
    expect(directive.filename).toBe('weird-skill-name.md');
  });

  describe('applyDeliveryDirective', () => {
    it('sets deliveryMode + echoes under metadata when document', () => {
      const directive = {
        deliveryMode: 'document' as const,
        source: 'frontmatter' as const,
        filename: 'r.md',
        mime: 'text/markdown',
      };
      const result = applyDeliveryDirective({ text: 'hello' }, directive);
      expect(result.deliveryMode).toBe('document');
      expect(result.metadata.deliveryMode).toBe('document');
      expect(result.metadata.deliveryModeSource).toBe('frontmatter');
      expect(result.attachments).toHaveLength(1);
      const attachment = (result.attachments as Array<Record<string, unknown>>)[0];
      expect(attachment?.filename).toBe('r.md');
      expect(attachment?.content).toBe('hello');
      expect(attachment?.source).toBe('skill-as-document');
    });

    it('preserves existing attachments when adding document', () => {
      const existing = { filename: 'existing.png', mime: 'image/png', content: '...' };
      const directive = {
        deliveryMode: 'document' as const,
        source: 'body' as const,
        filename: 'r.md',
        mime: 'text/markdown',
      };
      const result = applyDeliveryDirective(
        { text: 'hi', attachments: [existing] },
        directive,
      );
      expect(result.attachments).toHaveLength(2);
      const attachments = result.attachments as Array<Record<string, unknown>>;
      expect(attachments[0]).toEqual(existing);
      expect(attachments[1]?.filename).toBe('r.md');
    });

    it('inline mode does not add attachments', () => {
      const directive = {
        deliveryMode: 'inline' as const,
        source: 'none' as const,
      };
      const result = applyDeliveryDirective({ text: 'short' }, directive);
      expect(result.deliveryMode).toBe('inline');
      // No deliveryModeSource when source === 'none' (avoids noise in
      // metadata for the vast majority of inline-by-default skills).
      expect(result.metadata.deliveryModeSource).toBeUndefined();
      expect(result.attachments).toBeUndefined();
    });

    it('preserves existing metadata keys', () => {
      const directive = {
        deliveryMode: 'document' as const,
        source: 'frontmatter' as const,
        filename: 'r.md',
      };
      const result = applyDeliveryDirective(
        { text: 'x', metadata: { traceId: 'abc' } },
        directive,
      );
      expect(result.metadata.traceId).toBe('abc');
      expect(result.metadata.deliveryMode).toBe('document');
    });

    it('uses default filename when directive omits it', () => {
      const directive = {
        deliveryMode: 'document' as const,
        source: 'body' as const,
      };
      const result = applyDeliveryDirective({ text: 'x' }, directive);
      const attachment = (result.attachments as Array<Record<string, unknown>>)[0];
      expect(attachment?.filename).toBe('skill-output.md');
    });
  });

  describe('end-to-end: parsed skill → applied to outgoing message', () => {
    it('long-report skill with body marker routes as document', () => {
      const parsed = parseSkillFile(FRONT(
        'name: long-report\ndescription: long\ntriggers: [report]',
        'You produce a long markdown report.\n[[as_document]]\n',
      ));
      const directive = detectSkillDeliveryDirective(parsed!);
      const outgoing = applyDeliveryDirective(
        { text: '# Report\n\n...thousands of lines...' },
        directive,
      );
      expect(outgoing.deliveryMode).toBe('document');
      const attachments = outgoing.attachments as Array<Record<string, unknown>>;
      expect(attachments[0]?.filename).toBe('long-report.md');
      expect(attachments[0]?.content).toContain('# Report');
    });

    it('plain skill stays inline through the full pipeline', () => {
      const parsed = parseSkillFile(FRONT(
        'name: greet\ndescription: greet\ntriggers: [hi]',
        'Greet the user.',
      ));
      const directive = detectSkillDeliveryDirective(parsed!);
      const outgoing = applyDeliveryDirective({ text: 'Hi!' }, directive);
      expect(outgoing.deliveryMode).toBe('inline');
      expect(outgoing.attachments).toBeUndefined();
    });
  });
});
