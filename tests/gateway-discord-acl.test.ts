/**
 * Tests for #294 — Discord guild-scoped role allowlist (Hermes v0.13, CVSS 8.1).
 *
 * The critical path here is the CVSS 8.1 fix: a user holding a role with the
 * same NAME in any other guild used to pass the gate. With the new
 * `(guildId, roleIds)` tuple ACL, that bypass is closed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkDiscordAcl,
  loadDiscordAclConfig,
  isLegacyAllowedRolesShape,
  extractDiscordAclInput,
  discordChannel,
  setAclEventSink,
  type AclDeniedEvent,
} from '../packages/gateway/src/index.js';

describe('isLegacyAllowedRolesShape', () => {
  it('detects flat string[] (legacy Hermes shape)', () => {
    expect(isLegacyAllowedRolesShape(['admin', 'mod'])).toBe(true);
  });

  it('rejects the new tuple shape', () => {
    expect(isLegacyAllowedRolesShape([{ guildId: 'g1', roleIds: ['r1'] }])).toBe(false);
  });

  it('returns false on empty array (no legacy info to migrate)', () => {
    expect(isLegacyAllowedRolesShape([])).toBe(false);
  });

  it('returns false on non-array input', () => {
    expect(isLegacyAllowedRolesShape(undefined)).toBe(false);
    expect(isLegacyAllowedRolesShape('admin')).toBe(false);
    expect(isLegacyAllowedRolesShape(null)).toBe(false);
  });
});

describe('loadDiscordAclConfig', () => {
  it('forces deny-all when legacy string[] shape is detected', () => {
    const warnings: string[] = [];
    const config = loadDiscordAclConfig({ allowedRoles: ['admin', 'mod'] }, (m) => warnings.push(m));
    expect(config.allowedRoles).toHaveLength(0);
    expect(config.allowDirectMessages).toBe(false);
    expect(warnings.some((w) => w.includes('legacy'))).toBe(true);
    expect(warnings.some((w) => w.includes('CVSS 8.1'))).toBe(true);
  });

  it('passes through the new tuple shape', () => {
    const config = loadDiscordAclConfig({
      allowedRoles: [{ guildId: 'g1', roleIds: ['r1', 'r2'] }],
      allowDirectMessages: true,
      dmAllowlist: ['u1'],
    });
    expect(config.allowedRoles).toEqual([{ guildId: 'g1', roleIds: ['r1', 'r2'] }]);
    expect(config.allowDirectMessages).toBe(true);
    expect(config.dmAllowlist).toEqual(['u1']);
  });

  it('filters malformed entries silently', () => {
    const config = loadDiscordAclConfig({
      allowedRoles: [
        { guildId: 'g1', roleIds: ['r1'] },
        { roleIds: ['r2'] }, // missing guildId
        null,
        42,
        { guildId: 'g2' }, // missing roleIds → empty roleIds
      ],
    });
    expect(config.allowedRoles).toEqual([
      { guildId: 'g1', roleIds: ['r1'] },
      { guildId: 'g2', roleIds: [] },
    ]);
  });
});

describe('checkDiscordAcl — guild-scoped role allowlist', () => {
  it('allows when sender holds an allowlisted role in the originating guild', () => {
    const decision = checkDiscordAcl(
      { guildId: 'g1', memberRoleIds: ['r1', 'rZ'], senderId: 'u1' },
      { allowedRoles: [{ guildId: 'g1', roleIds: ['r1'] }] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });

  it('CVSS 8.1 fix: rejects same role-id when used in an unrelated guild', () => {
    // User has r1 in guild g2; allowlist only blesses r1 in guild g1.
    // Pre-fix: passed because role-name matched globally.
    const decision = checkDiscordAcl(
      { guildId: 'g2', memberRoleIds: ['r1'], senderId: 'u1' },
      { allowedRoles: [{ guildId: 'g1', roleIds: ['r1'] }] },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('guild-not-allowlisted');
    expect(decision.guildId).toBe('g2');
  });

  it('fails closed on DMs by default (no guild_id, allowDirectMessages off)', () => {
    const decision = checkDiscordAcl(
      { memberRoleIds: [], senderId: 'u1' },
      { allowedRoles: [{ guildId: 'g1', roleIds: ['r1'] }] },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no-guild-id');
  });

  it('DMs allowed only when allowDirectMessages is true AND sender is in dmAllowlist', () => {
    const config = {
      allowedRoles: [{ guildId: 'g1', roleIds: ['r1'] }],
      allowDirectMessages: true,
      dmAllowlist: ['u-trusted'],
    };
    expect(
      checkDiscordAcl({ memberRoleIds: [], senderId: 'u-trusted' }, config),
    ).toEqual({ allowed: true, reason: 'dm-allowlisted' });
    expect(
      checkDiscordAcl({ memberRoleIds: [], senderId: 'u-other' }, config),
    ).toEqual({ allowed: false, reason: 'dm-not-allowed' });
  });

  it('DM allowlist wildcard accepts anyone when allowDirectMessages is true', () => {
    const decision = checkDiscordAcl(
      { memberRoleIds: [], senderId: 'anyone' },
      { allowedRoles: [], allowDirectMessages: true, dmAllowlist: ['*'] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('dm-allowlisted');
  });

  it('rejects when sender has no roles in the allowlisted guild', () => {
    const decision = checkDiscordAcl(
      { guildId: 'g1', memberRoleIds: [], senderId: 'u1' },
      { allowedRoles: [{ guildId: 'g1', roleIds: ['r1'] }] },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing-roles');
  });

  it('rejects when sender has roles but none match the allowlisted set', () => {
    const decision = checkDiscordAcl(
      { guildId: 'g1', memberRoleIds: ['rOther'], senderId: 'u1' },
      { allowedRoles: [{ guildId: 'g1', roleIds: ['r1'] }] },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('role-not-allowlisted');
  });

  it('wildcard inside guild entry treats any role as allowed', () => {
    const decision = checkDiscordAcl(
      { guildId: 'g1', memberRoleIds: ['rOther'], senderId: 'u1' },
      { allowedRoles: [{ guildId: 'g1', roleIds: ['*'] }] },
    );
    expect(decision.allowed).toBe(true);
  });

  it('falls back to open-policy when fully unconfigured', () => {
    const decision = checkDiscordAcl(
      { guildId: 'g1', memberRoleIds: ['rOther'], senderId: 'u1' },
      { allowedRoles: [] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('open-policy');
  });
});

describe('extractDiscordAclInput', () => {
  it('extracts guild_id, member.roles, author.id from gateway envelope', () => {
    const input = extractDiscordAclInput({
      t: 'MESSAGE_CREATE',
      d: {
        guild_id: 'g1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'alice' },
        member: { roles: ['r1', 'r2'] },
        content: 'hi',
      },
    });
    expect(input).toEqual({ guildId: 'g1', memberRoleIds: ['r1', 'r2'], senderId: 'u1' });
  });

  it('handles bare payload (no `d` envelope)', () => {
    const input = extractDiscordAclInput({
      guild_id: 'g7',
      author: { id: 'u9' },
      member: { roles: ['rX'] },
    });
    expect(input).toEqual({ guildId: 'g7', memberRoleIds: ['rX'], senderId: 'u9' });
  });

  it('returns null when no author id is present', () => {
    const input = extractDiscordAclInput({ d: { guild_id: 'g1' } });
    expect(input).toBeNull();
  });

  it('returns empty memberRoleIds for DMs (no member object)', () => {
    const input = extractDiscordAclInput({ d: { author: { id: 'u1' } } });
    expect(input?.guildId).toBeUndefined();
    expect(input?.memberRoleIds).toEqual([]);
    expect(input?.senderId).toBe('u1');
  });
});

describe('discordChannel.checkAccess integration', () => {
  let captured: AclDeniedEvent[] = [];
  let restoreSink: () => void = () => {};

  beforeEach(() => {
    captured = [];
    const previous = setAclEventSink((event) => captured.push(event));
    restoreSink = () => setAclEventSink(previous);
  });

  const buildPayload = (overrides: Record<string, unknown> = {}) => ({
    t: 'MESSAGE_CREATE',
    d: {
      channel_id: 'c-1',
      author: { id: 'u-1' },
      member: { roles: ['r-1'] },
      content: 'hi',
      ...overrides,
    },
  });

  it('rejects DM (no guild_id) by default and emits audit event', () => {
    const payload = buildPayload();
    const normalized = discordChannel.normalizeInbound(payload);
    const decision = discordChannel.checkAccess?.(payload, normalized!, {
      allowedRoles: [{ guildId: 'g1', roleIds: ['r-1'] }],
    });
    expect(decision?.allowed).toBe(false);
    expect(decision?.reason).toBe('no-guild-id');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.platform).toBe('discord');
    expect(captured[0]?.reason).toBe('no-guild-id');
    restoreSink();
  });

  it('rejects same role in a non-allowlisted guild (CVSS 8.1 bypass closed)', () => {
    const payload = buildPayload({ guild_id: 'g2' });
    const normalized = discordChannel.normalizeInbound(payload);
    const decision = discordChannel.checkAccess?.(payload, normalized!, {
      allowedRoles: [{ guildId: 'g1', roleIds: ['r-1'] }],
    });
    expect(decision?.allowed).toBe(false);
    expect(captured[0]?.guildId).toBe('g2');
    restoreSink();
  });

  it('legacy string[] config blocks the agent loop until reconfigured', () => {
    const payload = buildPayload({ guild_id: 'g1' });
    const normalized = discordChannel.normalizeInbound(payload);
    const decision = discordChannel.checkAccess?.(payload, normalized!, {
      allowedRoles: ['admin'], // legacy shape — should force deny-all
    });
    expect(decision?.allowed).toBe(false);
    restoreSink();
  });

  it('allowed when guild + role match', () => {
    const payload = buildPayload({ guild_id: 'g1' });
    const normalized = discordChannel.normalizeInbound(payload);
    const decision = discordChannel.checkAccess?.(payload, normalized!, {
      allowedRoles: [{ guildId: 'g1', roleIds: ['r-1'] }],
    });
    expect(decision?.allowed).toBe(true);
    expect(captured).toHaveLength(0);
    restoreSink();
  });
});
