/**
 * Shared CLI types used by both `index.ts` and `commands/*`. Lives in its
 * own module to avoid the circular import that would happen if commands
 * imported the runtime interface from `index.ts` while `index.ts` also
 * re-exports the commands.
 *
 * Kept structurally identical to `CliRuntimeLike` in index.ts — both refer
 * to the same shape. If you change one, change the other.
 */

export interface CliRuntimeLike {
  fetch(request: Request): Promise<Response>;
  tools?: { list(): Array<{ name: string; description?: string }> };
  close?(): void | Promise<void>;
}
