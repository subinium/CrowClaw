import { describe, it, expect } from 'vitest';
import {
  isHardlineBlocked,
  normalizeForHardline,
} from '../packages/core/src/hardline-blocklist.js';

const tc = (name: string, input: Record<string, unknown>) => ({ name, input });

describe('hardline-blocklist — baseline coverage', () => {
  it('blocks rm -rf /', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf /' }));
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.description).toMatch(/Recursive force delete from \//);
  });

  it('blocks rm -rf ~', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf ~' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks dd of=/dev/sda', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'dd if=/dev/zero of=/dev/sda bs=1M' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks classic fork bomb', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: ':(){ :|:& };:' }));
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.description).toMatch(/Fork bomb/);
  });

  it('blocks force-push to main', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'git push --force origin main' }));
    expect(r.blocked).toBe(true);
  });

  it('does not block legitimate rm', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm build/foo.js' }));
    expect(r.blocked).toBe(false);
  });

  it('does not block git push without force', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'git push origin feature/x' }));
    expect(r.blocked).toBe(false);
  });
});

describe('hardline-blocklist — issue #65: named system paths', () => {
  it('blocks rm -rf /etc', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf /etc' }));
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.description).toMatch(/named system path/);
  });

  it('blocks rm -rf /etc/postgresql', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf /etc/postgresql' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks rm -rf /var/lib/postgresql', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf /var/lib/postgresql' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks rm -rf /usr', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf /usr' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks rm -rf /boot', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf /boot' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks rm -rf $HOME', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf $HOME' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks rm -rf $HOME/projects', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf $HOME/projects' }));
    expect(r.blocked).toBe(true);
  });

  it('blocks rm -rf ~/projects', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf ~/projects' }));
    expect(r.blocked).toBe(true);
  });

  it('does NOT block rm -rf node_modules (legitimate)', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf node_modules' }));
    expect(r.blocked).toBe(false);
  });

  it('does NOT block rm -rf ./dist (legitimate)', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf ./dist' }));
    expect(r.blocked).toBe(false);
  });
});

describe('hardline-blocklist — issue #65: shell-encoding evasion (CVE-2026-28460)', () => {
  it('catches rm -rf / with line continuation backslash-newline', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm -rf \\\n/' }));
    expect(r.blocked).toBe(true);
  });

  it('catches rm -rf /etc inserted via $(...) substitution', () => {
    // The substitution itself is collapsed; the surrounding command remains.
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm $(echo -rf) /etc' }));
    expect(r.blocked).toBe(true);
  });

  it('catches rm -rf /etc inserted via backtick substitution', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm `echo -rf` /etc' }));
    expect(r.blocked).toBe(true);
  });

  it('catches rm -rf with embedded ANSI color escape', () => {
    // \x1B[31m would otherwise sit between `rm` and `-rf` and break the regex.
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'rm \x1B[31m-rf /etc' }));
    expect(r.blocked).toBe(true);
  });

  it('catches a renamed fork bomb', () => {
    const r = isHardlineBlocked(tc('terminal.exec', { command: 'bomb(){ bomb|bomb& };bomb' }));
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.description).toMatch(/Fork bomb/);
  });
});

describe('normalizeForHardline — primitives', () => {
  it('strips line continuations', () => {
    expect(normalizeForHardline('rm -rf \\\n/')).toContain('rm -rf /');
  });

  it('strips ANSI CSI sequences', () => {
    expect(normalizeForHardline('rm \x1B[31m-rf /')).toBe('rm -rf /');
  });

  it('collapses $(...) substitutions to placeholder', () => {
    expect(normalizeForHardline('rm $(echo -rf) /etc')).toBe('rm __SUBST__ /etc');
  });

  it('collapses backtick substitutions to placeholder', () => {
    expect(normalizeForHardline('rm `echo -rf` /etc')).toBe('rm __SUBST__ /etc');
  });

  it("normalizes shell-quote escape '\\''", () => {
    expect(normalizeForHardline("echo 'a'\\''b'")).toBe("echo 'a'b'");
  });

  it('collapses runs of whitespace', () => {
    expect(normalizeForHardline('rm   -rf    /etc')).toBe('rm -rf /etc');
  });
});
