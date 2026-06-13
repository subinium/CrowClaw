/**
 * v0.9.1 "Sentinel" (#361 / #365): Host-header (BadHost / DNS-rebinding) and
 * WebSocket Origin validation primitives.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveAllowedHosts,
  isHostAllowed,
  isOriginAllowed,
} from '../packages/runtime-node/src/config-schema.js';

describe('resolveAllowedHosts (#361)', () => {
  it('always includes the localhost family', () => {
    const hosts = resolveAllowedHosts(null, null);
    expect(hosts).toContain('localhost');
    expect(hosts).toContain('127.0.0.1');
  });

  it('adds the configured bind host but not a wildcard interface', () => {
    expect(resolveAllowedHosts('agent.example.com', null)).toContain('agent.example.com');
    const wild = resolveAllowedHosts('0.0.0.0', null);
    expect(wild).not.toContain('0.0.0.0');
  });

  it('merges operator-configured allowed hosts (lowercased)', () => {
    expect(resolveAllowedHosts(null, ['API.Example.COM'])).toContain('api.example.com');
  });
});

describe('isHostAllowed (#361)', () => {
  const allowed = resolveAllowedHosts('agent.example.com', ['*.corp.example.com']);

  it('allows a MISSING Host header (in-process / native client — no rebinding vector)', () => {
    expect(isHostAllowed(undefined, allowed)).toBe(true);
    expect(isHostAllowed(null, allowed)).toBe(true);
    expect(isHostAllowed('', allowed)).toBe(true);
  });

  it('allows a present, allowlisted Host (with or without a port)', () => {
    expect(isHostAllowed('localhost', allowed)).toBe(true);
    expect(isHostAllowed('agent.example.com', allowed)).toBe(true);
    expect(isHostAllowed('agent.example.com:3117', allowed)).toBe(true);
  });

  it('allows a wildcard-subdomain match', () => {
    expect(isHostAllowed('api.corp.example.com', allowed)).toBe(true);
  });

  it('rejects a present, disallowed Host (the BadHost / rebinding case)', () => {
    expect(isHostAllowed('evil.com', allowed)).toBe(false);
    expect(isHostAllowed('attacker.example.net', allowed)).toBe(false);
  });
});

describe('isOriginAllowed (#365)', () => {
  it('allows a missing Origin (same-origin / native WS client)', () => {
    expect(isOriginAllowed(undefined, [], 'localhost')).toBe(true);
    expect(isOriginAllowed('', [], 'localhost')).toBe(true);
  });

  it('with an empty allowlist, allows only a same-origin Origin', () => {
    expect(isOriginAllowed('http://localhost', [], 'localhost')).toBe(true);
    expect(isOriginAllowed('http://evil.com', [], 'localhost')).toBe(false);
  });

  it('with a configured allowlist, matches strictly', () => {
    expect(isOriginAllowed('https://app.example.com', ['app.example.com'], 'localhost')).toBe(true);
    expect(isOriginAllowed('https://evil.com', ['app.example.com'], 'localhost')).toBe(false);
  });
});
