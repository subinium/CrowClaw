/**
 * WhatsApp stranger + self-chat ban.
 *
 * Closes Hermes v0.13 ([#21291](https://github.com/NousResearch/hermes-agent/pull/21291),
 * closes [#8389](https://github.com/NousResearch/hermes-agent/issues/8389)) — the
 * WhatsApp gateway previously responded to **any** inbound message, including
 * unsolicited DMs from strangers and messages from the bot's own account
 * (echo / self-loop). This module defaults to deny-stranger and unconditional
 * self-chat suppression.
 *
 * Decision shape mirrors `destination-acl.ts` so callers can multiplex audit
 * events through one `gateway:acl_denied` channel.
 */

import { buildAclDeniedEvent, emitAclDenied, type AclDeniedEvent } from './destination-acl.js';

export interface WhatsAppAclConfig {
  /**
   * `wa_id`s (typically the E.164 phone number minus the `+`) of contacts
   * permitted to reach the agent loop. Empty when `allowStrangers: true`.
   */
  allowedContacts: string[];
  /**
   * When `true`, anyone may DM the bot. Legacy/pre-fix behavior. Off by
   * default in v0.9.0 — flip to `true` only with an explicit audit-log
   * warning so operators understand the spend / prompt-injection exposure.
   */
  allowStrangers?: boolean;
  /**
   * Bot's own WhatsApp phone-number-id. When the inbound `from` matches, the
   * message is dropped silently (no audit event, no agent dispatch) — this is
   * how Hermes prevents the echo loop. Optional; if omitted, self-chat ban
   * cannot be enforced and a warning is logged at config-load time.
   */
  botWaId?: string;
}

export type WhatsAppAclReason =
  | 'allowed'
  | 'allowlisted'
  | 'open-policy'
  | 'self-chat'
  | 'stranger'
  | 'missing-sender';

export interface WhatsAppAclDecision {
  allowed: boolean;
  reason: WhatsAppAclReason;
  /** When true, callers MUST drop the message silently (no audit event). */
  silentDrop?: boolean;
}

export interface WhatsAppAclInput {
  /** Sender wa_id (phone number id) from the WhatsApp webhook `messages[0].from`. */
  senderWaId?: string;
}

/**
 * Evaluate an inbound WhatsApp message.
 *
 * Decision precedence:
 *   1. Sender wa_id missing → reject (`missing-sender`).
 *   2. Sender wa_id == bot wa_id → silent drop (`self-chat`). Never emits an
 *      audit event; never enqueues to the agent loop.
 *   3. `allowStrangers: true` → allow (open-policy) — operator explicitly
 *      opted in.
 *   4. Sender in `allowedContacts` → allow (allowlisted).
 *   5. Otherwise → reject (`stranger`). Callers MUST emit
 *      `gateway:acl_denied` with reason `stranger`.
 */
export function checkWhatsAppAcl(
  input: WhatsAppAclInput,
  config: WhatsAppAclConfig,
): WhatsAppAclDecision {
  if (!input.senderWaId) {
    return { allowed: false, reason: 'missing-sender' };
  }

  // Self-chat suppression. Silent drop — never audited, never dispatched.
  // This prevents the echo-loop spend bug described in Hermes #8389.
  if (config.botWaId && input.senderWaId === config.botWaId) {
    return { allowed: false, reason: 'self-chat', silentDrop: true };
  }

  if (config.allowStrangers === true) {
    return { allowed: true, reason: 'open-policy' };
  }

  const allowed = Array.isArray(config.allowedContacts) && config.allowedContacts.length > 0
    ? config.allowedContacts.includes(input.senderWaId) || config.allowedContacts.includes('*')
    : false;

  return allowed
    ? { allowed: true, reason: 'allowlisted' }
    : { allowed: false, reason: 'stranger' };
}

/**
 * Emit a `gateway:acl_denied` audit event tagged `whatsapp`.
 *
 * Caller responsibility:
 *   - When the decision returns `silentDrop: true` (self-chat), do **not**
 *     call this — the whole point is no audit/no response.
 *   - Otherwise, forward the returned event to the observability bus.
 */
export function emitWhatsAppAclDenied(input: {
  reason: WhatsAppAclReason;
  senderId?: string;
}): AclDeniedEvent {
  const event = buildAclDeniedEvent({
    platform: 'whatsapp',
    reason: input.reason,
    ...(input.senderId !== undefined ? { senderId: input.senderId } : {}),
  });
  emitAclDenied(event);
  return event;
}

/**
 * Normalize a raw `channels.whatsapp` config blob into a strict
 * `WhatsAppAclConfig`. Logs a warning when no `botWaId` is configured
 * (self-chat ban cannot be enforced in that case) but does not deny-all —
 * unlike Discord, the WhatsApp legacy shape is just `allowed_chats: []` and
 * is already represented.
 */
export function loadWhatsAppAclConfig(
  raw: unknown,
  warn: (message: string) => void = (msg) => console.warn(msg),
): WhatsAppAclConfig {
  const value = (raw ?? {}) as Record<string, unknown>;

  const allowedContacts = Array.isArray(value.allowedContacts)
    ? value.allowedContacts.filter((s): s is string => typeof s === 'string')
    : [];

  const allowStrangers =
    typeof value.allowStrangers === 'boolean' ? value.allowStrangers : false;

  const botWaId =
    typeof value.botWaId === 'string' && value.botWaId.trim().length > 0
      ? value.botWaId.trim()
      : undefined;

  if (!botWaId) {
    warn(
      '[crowclaw][whatsapp-acl] `botWaId` not configured — self-chat (echo loop) ' +
        'cannot be enforced. Configure `channels.whatsapp.botWaId` to your bot phone-number-id.',
    );
  }

  if (allowStrangers) {
    warn(
      '[crowclaw][whatsapp-acl] `allowStrangers: true` — bot will respond to any ' +
        'inbound WhatsApp message. This is the pre-v0.9.0 behavior and is exposed ' +
        'to prompt-injection-by-DM and overnight provider spend. Audit-only warning.',
    );
  }

  return {
    allowedContacts,
    allowStrangers,
    ...(botWaId !== undefined ? { botWaId } : {}),
  };
}
