/**
 * `writeSecretAtomic` — close TOCTOU window in credential file writers
 * (Hermes v0.13 parity #297).
 *
 * v0.9.1 (#297 debt-closure): the CLI no longer ships a private copy of this
 * helper. The canonical implementation lives in `@crowclaw/shared`
 * (`atomic-secret-write.ts`, issue #296) and this module is now a thin
 * re-export so there is a single source of truth for the symlink-/TOCTOU-safe
 * secret writer. The previous local copy (O_EXCL|O_NOFOLLOW temp file then
 * `rename` over the destination) duplicated the shared logic and could drift.
 *
 * Public surface is unchanged for callers: `writeSecretAtomic(path, data,
 * options?)` and the `WriteSecretAtomicOptions` type are both re-exported.
 * The shared options type is a superset of the old local one — it keeps the
 * `mode` field (default `0o600`) every CLI call site relies on and adds an
 * opt-out `rejectWorldWritableParent` guard (default `true`).
 *
 * Behavioral note (intentional hardening, see selfReviewConcerns in the
 * v0.9.1 manifest): the shared implementation *rejects* a write whose
 * destination is itself a symlink (throws `ELOOP`) instead of silently
 * replacing the symlink with a real file. This is the safer Hermes #296
 * semantics. The CLI config/auth writers always target a regular file under
 * `~/.crowclaw/`, so the stricter behavior is correct for every real call
 * site; only an attacker-planted symlink at the destination changes the
 * outcome (rejected rather than replaced).
 */

// -- v0.9.1 #297 dedup writeSecretAtomic BEGIN --
export {
  writeSecretAtomic,
  type WriteSecretAtomicOptions,
} from '@crowclaw/shared';
// -- v0.9.1 #297 dedup writeSecretAtomic END --
