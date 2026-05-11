/**
 * Discord guild-scoped role allowlist.
 *
 * Closes Hermes v0.13 ([#21241](https://github.com/NousResearch/hermes-agent/pull/21241),
 * closes [#12136](https://github.com/NousResearch/hermes-agent/issues/12136), **CVSS 8.1**)
 * cross-guild DM bypass.
 *
 * The Hermes pre-fix matched `DISCORD_ALLOWED_ROLES` by **role name globally**,
 * so a user who happened to hold a role with the same name in *any* unrelated
 * guild could DM the bot and pass the gate. Fix: scope role-allowlist evaluation
 * to `(guild_id, role_id)` tuples and **fail-closed** when `guild_id` is absent
 * (i.e. a direct message).
 *
 * In CrowClaw this primitive is intentionally standalone and side-effect free.
 * `channel-registry.ts` calls it; the runtime forwards
 * `gateway:acl_denied` events to the observability bus.
 */

import { buildAclDeniedEvent, emitAclDenied, type AclDeniedEvent } from './destination-acl.js';

/** Single `(guildId, roleIds)` entry — anchors role IDs to a specific guild. */
export interface DiscordGuildRoleEntry {
  guildId: string;
  roleIds: string[];
}

/**
 * Discord ACL configuration.
 *
 * `allowedRoles` is an array of `(guildId, roleIds)` tuples — role IDs are
 * **never** matched outside their owning guild.
 *
 * `allowDirectMessages` defaults to `false`. When `true`, DMs (messages with
 * no `guild_id`) bypass the role gate **only if** the sender's user-id is
 * in `dmAllowlist`.
 *
 * The legacy Hermes shape — a flat `string[]` of role *names* — is
 * intentionally not part of this interface. A migration helper
 * (`migrateLegacyAllowedRoles`) detects it and forces deny-all with a warning.
 */
export interface DiscordAclConfig {
  allowedRoles: DiscordGuildRoleEntry[];
  allowDirectMessages?: boolean;
  dmAllowlist?: string[];
  /**
   * Internal flag set by `loadDiscordAclConfig` when the legacy `string[]`
   * shape was detected and forcibly migrated to deny-all. When `true`,
   * `checkDiscordAcl` skips the open-policy fallback so the migration
   * cannot regress into open-access.
   */
  denyAllFromLegacy?: boolean;
}

export type DiscordAclReason =
  | 'allowed'
  | 'dm-allowlisted'
  | 'open-policy'
  | 'no-guild-id'
  | 'guild-not-allowlisted'
  | 'role-not-allowlisted'
  | 'missing-roles'
  | 'dm-not-allowed';

export interface DiscordAclDecision {
  allowed: boolean;
  reason: DiscordAclReason;
  guildId?: string;
}

export interface DiscordAclInput {
  /** Originating guild id. Undefined for DMs. */
  guildId?: string;
  /** Discord role IDs (NOT names) held by the message author in `guildId`. */
  memberRoleIds: string[];
  /** Author's Discord user id — used by the DM allowlist branch. */
  senderId: string;
}

/**
 * Evaluate an inbound Discord message against the guild-scoped allowlist.
 *
 * Decision precedence:
 *   1. Empty `allowedRoles` and no `dmAllowlist` → open-policy (backward compat).
 *   2. No `guildId` (DM) → only allowed when `allowDirectMessages: true` AND
 *      sender is in `dmAllowlist`. Otherwise rejected with `no-guild-id` or
 *      `dm-not-allowed`. This is the **fix for the CVSS 8.1 bypass**.
 *   3. Guild present → guild must appear in `allowedRoles`. Member must hold
 *      at least one of the guild's listed role ids.
 *
 * Returns a pure decision; callers emit `gateway:acl_denied` via
 * `emitDiscordAclDenied()` when `allowed: false`.
 */
export function checkDiscordAcl(
  input: DiscordAclInput,
  config: DiscordAclConfig,
): DiscordAclDecision {
  const allowedRoles = Array.isArray(config.allowedRoles) ? config.allowedRoles : [];
  const dmAllowlist = Array.isArray(config.dmAllowlist) ? config.dmAllowlist : [];
  const allowDM = config.allowDirectMessages === true;

  // Fully-unconfigured deployments retain the historical open-policy behavior
  // so existing dashboards don't lock themselves out on upgrade. The exception
  // is when `loadDiscordAclConfig` flagged the config as `denyAllFromLegacy`:
  // that means we just migrated away from the CVSS 8.1 vulnerable shape and
  // we must NOT silently re-open the bypass.
  if (
    !config.denyAllFromLegacy &&
    allowedRoles.length === 0 &&
    dmAllowlist.length === 0 &&
    !allowDM
  ) {
    return { allowed: true, reason: 'open-policy' };
  }

  // --- DM branch (no guild_id) ----------------------------------------------
  if (!input.guildId) {
    if (!allowDM) {
      return { allowed: false, reason: 'no-guild-id' };
    }
    if (dmAllowlist.includes(input.senderId) || dmAllowlist.includes('*')) {
      return { allowed: true, reason: 'dm-allowlisted' };
    }
    return { allowed: false, reason: 'dm-not-allowed' };
  }

  // --- Guild branch ---------------------------------------------------------
  const guildEntry = allowedRoles.find((entry) => entry.guildId === input.guildId);
  if (!guildEntry) {
    return { allowed: false, reason: 'guild-not-allowlisted', guildId: input.guildId };
  }

  if (!Array.isArray(input.memberRoleIds) || input.memberRoleIds.length === 0) {
    return { allowed: false, reason: 'missing-roles', guildId: input.guildId };
  }

  // The wildcard '*' inside a guild entry means "any role in this guild" —
  // useful when the operator wants the gate but not specific role filtering.
  if (guildEntry.roleIds.includes('*')) {
    return { allowed: true, reason: 'allowed', guildId: input.guildId };
  }

  const hasMatchingRole = input.memberRoleIds.some((roleId) =>
    guildEntry.roleIds.includes(roleId),
  );
  if (!hasMatchingRole) {
    return { allowed: false, reason: 'role-not-allowlisted', guildId: input.guildId };
  }

  return { allowed: true, reason: 'allowed', guildId: input.guildId };
}

/** Emit a `gateway:acl_denied` audit event tagged with platform `discord`. */
export function emitDiscordAclDenied(input: {
  reason: DiscordAclReason;
  guildId?: string;
  senderId?: string;
  destinationId?: string;
}): AclDeniedEvent {
  const event = buildAclDeniedEvent({
    platform: 'discord',
    reason: input.reason,
    ...(input.destinationId !== undefined ? { destinationId: input.destinationId } : {}),
    ...(input.senderId !== undefined ? { senderId: input.senderId } : {}),
    ...(input.guildId !== undefined ? { guildId: input.guildId } : {}),
  });
  emitAclDenied(event);
  return event;
}

/**
 * Detect the legacy Hermes `DISCORD_ALLOWED_ROLES = ["admin", "mod"]` shape.
 *
 * Returns `true` when the value is a non-empty array whose entries are
 * primitive strings (i.e. role names, not the new `{guildId, roleIds}` tuple).
 * Operators MUST re-configure under the new schema; until they do the runtime
 * forces deny-all and logs the warning emitted by `loadDiscordAclConfig`.
 */
export function isLegacyAllowedRolesShape(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry) => typeof entry === 'string');
}

/**
 * Normalize a raw `channels.discord` config blob into a strict
 * `DiscordAclConfig`. When the legacy shape is detected, logs a warning via
 * the provided `warn` callback and returns a deny-all config (empty allowlist,
 * `allowDirectMessages: false`) so the cross-guild bypass cannot persist.
 */
export function loadDiscordAclConfig(
  raw: unknown,
  warn: (message: string) => void = (msg) => console.warn(msg),
): DiscordAclConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const rawRoles = value.allowedRoles;

  if (isLegacyAllowedRolesShape(rawRoles)) {
    warn(
      '[crowclaw][discord-acl] legacy `allowedRoles: string[]` (role-name list) detected — ' +
        'this matched globally across guilds (CVSS 8.1 cross-guild bypass). ' +
        'Refusing to enforce until you reconfigure as `[{guildId, roleIds}]`. Channel is deny-all until then.',
    );
    return {
      allowedRoles: [],
      allowDirectMessages: false,
      dmAllowlist: [],
      denyAllFromLegacy: true,
    };
  }

  const allowedRoles: DiscordGuildRoleEntry[] = Array.isArray(rawRoles)
    ? rawRoles
        .map((entry): DiscordGuildRoleEntry | null => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          const guildId = typeof e.guildId === 'string' ? e.guildId : null;
          const roleIds = Array.isArray(e.roleIds)
            ? e.roleIds.filter((r): r is string => typeof r === 'string')
            : [];
          if (!guildId) return null;
          return { guildId, roleIds };
        })
        .filter((entry): entry is DiscordGuildRoleEntry => entry !== null)
    : [];

  const allowDirectMessages =
    typeof value.allowDirectMessages === 'boolean' ? value.allowDirectMessages : false;

  const dmAllowlist = Array.isArray(value.dmAllowlist)
    ? value.dmAllowlist.filter((s): s is string => typeof s === 'string')
    : [];

  return { allowedRoles, allowDirectMessages, dmAllowlist };
}

/**
 * Extract Discord ACL inputs from a raw Discord webhook payload.
 *
 * Handles both gateway-style envelopes (`{t, d: {...}}`) and bare event
 * objects (`{guild_id, author, member, ...}`), mirroring the existing
 * `discordChannel.normalizeInbound` heuristics.
 */
export function extractDiscordAclInput(payload: unknown): DiscordAclInput | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const d = (p.d ?? p) as Record<string, unknown> | undefined;
  if (!d) return null;

  const author = (d.author ?? d.user) as Record<string, unknown> | undefined;
  const senderId = author?.id !== undefined ? String(author.id) : undefined;
  if (!senderId) return null;

  const guildId = typeof d.guild_id === 'string' ? d.guild_id : undefined;

  // Discord `member.roles` is an array of snowflake strings.
  const member = d.member as Record<string, unknown> | undefined;
  const memberRoleIds = Array.isArray(member?.roles)
    ? (member?.roles as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];

  return { guildId, memberRoleIds, senderId };
}
