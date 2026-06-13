// -- v0.9.1 control-plane guard BEGIN --
/**
 * v0.9.1 (Sentinel) — Control-plane / credential file protection.
 *
 * An agent with workspace.read / workspace.write / workspace.list (or any
 * sandbox file op) can be coerced into reading the host's own control plane:
 * the runtime's auth.json / config.json, dotenv files, SSH / cloud-provider
 * credentials, the runtime data dir (~/.crowclaw), or private keys. Once any
 * of those leak, the SSRF floor (#298) and the env sanitizer are moot — the
 * attacker already holds the credentials.
 *
 * `assertSafeWorkspacePath` is the single choke point every file-touching tool
 * calls *before* the fs op. It enforces three independent layers:
 *
 *   (a) Deny-list — credential DIRECTORIES + key/dotenv files matched by
 *       segment, suffix, and home-relative prefix (.env / .env.*, ~/.ssh,
 *       ~/.aws, ~/.config/gcloud, ~/.crowclaw, ~/.docker, *.pem / *.key,
 *       id_rsa, ...). The runtime's own auth.json / config.json / credentials
 *       live inside these dirs, so they are caught by location — we do NOT
 *       blanket-ban those very common basenames, which are legitimate
 *       workspace files outside a credential dir.
 *   (b) Traversal — `..` segments that escape `workspaceRoot` after a lexical
 *       `resolve()` + prefix check. Engaged only when a workspaceRoot is
 *       supplied (the logical WorkspaceStore path space has no root to
 *       escape from on its own).
 *   (c) Symlink escape — `realpath` of the deepest existing ancestor, then
 *       a fresh prefix check so a symlink already planted inside the
 *       workspace can't redirect the op to a host file. Best-effort: skipped
 *       when realpath throws for reasons other than ENOENT.
 *
 * On denial it throws `ControlPlaneDeniedError` carrying the stable forensic
 * code `CONTROL_PLANE_DENIED` plus the matched rule, so the gateway audit log
 * and dashboards can route the event without parsing a free-form string.
 *
 * Why a thrown error (not a result envelope): the callers are deep inside fs
 * code paths that already `try/catch` around the store op and convert thrown
 * errors into `ok:false` envelopes. Throwing keeps the guard a single
 * pre-op line at each call site and fails closed.
 */

import { isAbsolute, resolve, relative, sep, dirname, basename } from 'node:path';

/** Stable forensic code carried by every control-plane denial. */
export const CONTROL_PLANE_DENIED = 'CONTROL_PLANE_DENIED' as const;

export type WorkspaceAccessKind = 'read' | 'write' | 'list';

/**
 * Which layer rejected the path. Recorded on the error so triage can tell a
 * credential-file hit (deny-list) apart from a sandbox-escape attempt
 * (traversal / symlink) without re-parsing the message.
 */
export type ControlPlaneDenialRule =
  | 'credential-deny-list'
  | 'path-traversal'
  | 'symlink-escape';

export interface AssertSafeWorkspacePathOptions {
  /**
   * Absolute filesystem root the path must stay within. When omitted, only
   * the credential deny-list (layer a) runs — there is no root to test
   * traversal / symlink escape against. The integrator should pass the
   * FileWorkspaceStore's resolved rootDir here.
   */
  workspaceRoot?: string;
  /** read | write | list — recorded in the forensic envelope only. */
  kind: WorkspaceAccessKind;
  /**
   * Extra deny globs layered on top of the built-in list. Supports the same
   * shapes as the workspace ignore patterns: `*.ext` (suffix), `name.*`
   * (prefix), or an exact segment/basename. Intended for operator-supplied
   * config (e.g. project-specific secret files).
   */
  extraDenyGlobs?: readonly string[];
  /**
   * Override the realpath resolver. Defaults to `node:fs/promises.realpath`.
   * Tests inject a stub; runtimes without a real fs (Cloudflare Workers)
   * pass `null` to skip layer (c) — the deny-list and traversal checks still
   * run, which is the meaningful protection there.
   */
  realpath?: ((p: string) => Promise<string>) | null;
}

/**
 * Thrown by `assertSafeWorkspacePath` when a path hits any guard layer.
 * `instanceof Error`, so existing tool `try/catch (err: unknown)` blocks
 * narrow it correctly and surface `err.message`.
 */
export class ControlPlaneDeniedError extends Error {
  /** Stable forensic code. */
  readonly code = CONTROL_PLANE_DENIED;
  /** The path the caller attempted (as supplied). */
  readonly attemptedPath: string;
  /** Which layer rejected it. */
  readonly rule: ControlPlaneDenialRule;
  /** read | write | list. */
  readonly kind: WorkspaceAccessKind;
  /** Canonical / resolved path that triggered the denial, when known. */
  readonly resolvedPath?: string;

  constructor(params: {
    attemptedPath: string;
    rule: ControlPlaneDenialRule;
    kind: WorkspaceAccessKind;
    resolvedPath?: string;
    reason: string;
  }) {
    super(`Control-plane access denied (${params.rule}): ${params.reason}`);
    this.name = 'ControlPlaneDeniedError';
    this.attemptedPath = params.attemptedPath;
    this.rule = params.rule;
    this.kind = params.kind;
    this.resolvedPath = params.resolvedPath;
  }
}

/**
 * Exact path segments (a single component between separators) that are never
 * legitimate agent targets. A match anywhere in the path's segment list
 * denies the whole path so `foo/.ssh/id_rsa` is caught on `.ssh`.
 */
const DENY_SEGMENTS: ReadonlySet<string> = new Set([
  // Credential DIRECTORIES — a path that traverses into any of these is never
  // a legitimate workspace target. The runtime's own auth.json / config.json /
  // credentials live inside these dirs (~/.crowclaw, ~/.aws, ~/.docker, ...),
  // so they stay protected here without blanket-banning those very common
  // basenames everywhere (a workspace file literally named `config.json` or
  // `auth.json` is legitimate and must remain writable).
  '.env',
  '.ssh',
  '.aws',
  '.gnupg',
  '.crowclaw', // runtime data dir — holds the runtime's auth.json/config.json
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.docker', // ~/.docker/config.json holds registry creds
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

/**
 * Multi-segment path suffixes that must be denied even though no single
 * segment is itself sensitive (e.g. `.config/gcloud`). Matched against the
 * normalized, forward-slash segment list as a contiguous tail-or-interior
 * run.
 */
const DENY_SEGMENT_RUNS: ReadonlyArray<readonly string[]> = [
  ['.config', 'gcloud'],
  ['.config', 'gh'], // GitHub CLI token store
  ['.kube', 'config'],
];

/** File suffix globs (`*.ext`). */
const DENY_SUFFIXES: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.keystore'];

/** Filename prefix globs (`prefix.*`) — matched on a single basename. */
const DENY_PREFIX_GLOBS: readonly string[] = ['.env.'];

/**
 * Normalize a supplied path into a forward-slash segment list. Handles both
 * POSIX and Windows separators, strips empty / `.` segments, and lowercases
 * nothing (credential filenames are case-sensitive on POSIX; matching is
 * exact). A leading `~` is expanded to a sentinel so home-relative inputs
 * (`~/.ssh/id_rsa`) are still screened.
 */
function toSegments(inputPath: string): string[] {
  const withoutHome = inputPath.replace(/^~(?=$|[\\/])/, '');
  return withoutHome
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.');
}

function matchesExtraGlob(segment: string, glob: string): boolean {
  if (glob.startsWith('*.')) {
    return segment.endsWith(glob.slice(1));
  }
  if (glob.endsWith('.*')) {
    return segment.startsWith(glob.slice(0, -2) + '.');
  }
  return segment === glob;
}

/**
 * Run the credential deny-list (layer a) against a path's segments. Returns a
 * human-readable reason when denied, or null when the deny-list is clear.
 */
function checkDenyList(
  segments: string[],
  extraDenyGlobs: readonly string[],
): string | null {
  for (const segment of segments) {
    if (DENY_SEGMENTS.has(segment)) {
      return `path contains protected segment '${segment}'`;
    }
    for (const suffix of DENY_SUFFIXES) {
      if (segment.endsWith(suffix)) {
        return `path targets a private key file ('${segment}' ends with '${suffix}')`;
      }
    }
    for (const prefix of DENY_PREFIX_GLOBS) {
      if (segment.startsWith(prefix)) {
        return `path targets a dotenv file ('${segment}')`;
      }
    }
    for (const glob of extraDenyGlobs) {
      if (matchesExtraGlob(segment, glob)) {
        return `path matches operator deny glob '${glob}' ('${segment}')`;
      }
    }
  }

  for (const run of DENY_SEGMENT_RUNS) {
    for (let start = 0; start + run.length <= segments.length; start += 1) {
      let allMatch = true;
      for (let offset = 0; offset < run.length; offset += 1) {
        if (segments[start + offset] !== run[offset]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        return `path contains protected location '${run.join('/')}'`;
      }
    }
  }

  return null;
}

/**
 * True when `candidate` is inside (or equal to) `root`. Both must already be
 * absolute. Uses `relative` so a `..`-only or absolute relative result means
 * the candidate escaped.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolve `target` against the workspace, expanding symlinks via realpath on
 * the deepest existing ancestor (the file itself may not exist yet on write).
 * Returns the canonical absolute path. Mirrors the FileWorkspaceStore walk so
 * the two layers agree on what "inside the workspace" means.
 */
async function realpathOrAncestor(
  realpathFn: (p: string) => Promise<string>,
  target: string,
): Promise<string> {
  const trailing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpathFn(current);
      return trailing.length === 0 ? real : resolve(real, ...trailing);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Reached filesystem root without an existing ancestor — fall back to
        // the lexically resolved target.
        return target;
      }
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

let cachedRealpath: ((p: string) => Promise<string>) | null | undefined;

async function loadDefaultRealpath(): Promise<((p: string) => Promise<string>) | null> {
  if (cachedRealpath !== undefined) return cachedRealpath;
  try {
    const fs = (await import('node:fs/promises')) as unknown as {
      realpath(path: string): Promise<string>;
    };
    cachedRealpath = (p: string) => fs.realpath(p);
  } catch {
    cachedRealpath = null;
  }
  return cachedRealpath;
}

/**
 * Assert that `targetPath` is safe for the requested workspace operation.
 * Throws `ControlPlaneDeniedError` (code `CONTROL_PLANE_DENIED`) on any
 * deny-list, traversal, or symlink-escape hit. Resolves with `void` when the
 * path is allowed.
 *
 * Call this *before* the fs / store operation at every file-touching tool.
 */
export async function assertSafeWorkspacePath(
  targetPath: string,
  options: AssertSafeWorkspacePathOptions,
): Promise<void> {
  const { kind, workspaceRoot, extraDenyGlobs = [] } = options;

  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new ControlPlaneDeniedError({
      attemptedPath: String(targetPath),
      rule: 'path-traversal',
      kind,
      reason: 'empty or non-string path',
    });
  }

  // Layer (a): credential deny-list. Runs on the raw segments so a home-
  // relative or absolute input is screened by name even without a root.
  const segments = toSegments(targetPath);
  const denyReason = checkDenyList(segments, extraDenyGlobs);
  if (denyReason) {
    throw new ControlPlaneDeniedError({
      attemptedPath: targetPath,
      rule: 'credential-deny-list',
      kind,
      reason: denyReason,
    });
  }

  // Layers (b) and (c) need a root to test escape against.
  if (!workspaceRoot) return;
  const root = resolve(workspaceRoot);

  // Layer (b): lexical traversal. Resolve the (possibly relative) target
  // under the root and confirm it stays inside. An absolute target is
  // resolved as-is, so `/etc/passwd` lands outside the root and is rejected.
  const lexicalTarget = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(root, targetPath);
  if (!isInsideRoot(root, lexicalTarget)) {
    throw new ControlPlaneDeniedError({
      attemptedPath: targetPath,
      rule: 'path-traversal',
      kind,
      resolvedPath: lexicalTarget,
      reason: `'${targetPath}' resolves to ${lexicalTarget} outside workspace root`,
    });
  }

  // Layer (c): symlink escape. realpath the deepest existing ancestor and
  // re-check containment. Skipped when no realpath impl is available.
  const realpathFn =
    options.realpath === undefined ? await loadDefaultRealpath() : options.realpath;
  if (!realpathFn) return;

  // Also resolve the root through realpath so a workspace whose root is itself
  // reached via a symlink doesn't false-positive on every path.
  let rootReal: string;
  try {
    rootReal = await realpathFn(root);
  } catch {
    rootReal = root;
  }

  const canonical = await realpathOrAncestor(realpathFn, lexicalTarget);
  if (!isInsideRoot(rootReal, canonical)) {
    throw new ControlPlaneDeniedError({
      attemptedPath: targetPath,
      rule: 'symlink-escape',
      kind,
      resolvedPath: canonical,
      reason: `'${targetPath}' resolves via symlink to ${canonical} outside workspace root`,
    });
  }
}

/**
 * Build the audit-log payload for a control-plane denial. Callers feed this
 * into the security audit log. Structured so dashboards parse it without a
 * schema migration (mirrors `ssrfAuditDetail`).
 */
export function controlPlaneAuditDetail(error: ControlPlaneDeniedError): string {
  const parts = [
    `code=${error.code}`,
    `rule=${error.rule}`,
    `kind=${error.kind}`,
    `attemptedPath=${error.attemptedPath}`,
  ];
  if (error.resolvedPath) parts.push(`resolvedPath=${error.resolvedPath}`);
  return parts.join(' ');
}
// -- v0.9.1 control-plane guard END --
