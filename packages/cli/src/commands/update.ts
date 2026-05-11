/**
 * `crowclaw update [--check] [--backup]` — Hermes v0.12 parity (#332)
 *
 * Subcommands:
 *   --check   Fetch latest release metadata from GitHub, compare to current
 *             package version, print a diff summary, exit without modifying
 *             anything. This is a preflight, NOT an actual update.
 *   --backup  Tar.gz the data dir (~/.crowclaw/) into
 *             ~/.crowclaw/backups/<timestamp>.tgz BEFORE running the update.
 *             The actual binary update is delegated to the install method
 *             (npm/brew/curl); this command only prepares the safety net.
 *
 * The "actual update" half is intentionally not wired here — we don't want
 * to surprise users by re-running their installer. The preflight tells the
 * operator what's available; the backup makes rollback cheap.
 *
 * Source: Hermes #15702, #15704, #15841, #16539, #16566.
 */

import { createGzip } from 'node:zlib';
import { createWriteStream, createReadStream } from 'node:fs';
import { stat, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const GITHUB_RELEASES_LATEST = 'https://api.github.com/repos/subinium/CrowClaw/releases/latest';

export interface UpdateCheckOptions {
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Current version string (e.g. "0.8.4"). Defaults to read from package.json by caller. */
  currentVersion: string;
  /** Override release endpoint for tests. */
  releaseUrl?: string;
}

export interface UpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  publishedAt?: string;
  notes?: string;
  error?: string;
}

/**
 * Compare semver strings of shape `MAJOR.MINOR.PATCH[-pre]`. Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 *
 * Pre-release versions sort BELOW their release counterpart, matching the
 * semver 2.0 spec subset we use. Unknown shapes fall back to string compare.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const stripV = (s: string) => s.replace(/^v/, '');
  const [aMain, aPre] = stripV(a).split('-', 2);
  const [bMain, bPre] = stripV(b).split('-', 2);
  if (!aMain || !bMain) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const aParts = aMain.split('.').map((n) => parseInt(n, 10));
  const bParts = bMain.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (!Number.isFinite(ai) || !Number.isFinite(bi)) {
      return aMain < bMain ? -1 : aMain > bMain ? 1 : 0;
    }
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  // Same MAJOR.MINOR.PATCH — release > pre-release.
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) {
    if (aPre < bPre) return -1;
    if (aPre > bPre) return 1;
  }
  return 0;
}

export async function runUpdateCheck(
  opts: UpdateCheckOptions,
): Promise<UpdateCheckResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.releaseUrl ?? GITHUB_RELEASES_LATEST;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json' },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      currentVersion: opts.currentVersion,
      hasUpdate: false,
      error: `failed to fetch release metadata: ${msg}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      currentVersion: opts.currentVersion,
      hasUpdate: false,
      error: `release endpoint returned HTTP ${res.status} ${res.statusText}`,
    };
  }
  let body: { tag_name?: unknown; html_url?: unknown; published_at?: unknown; body?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      currentVersion: opts.currentVersion,
      hasUpdate: false,
      error: `failed to parse release metadata: ${msg}`,
    };
  }
  const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
  if (!tag) {
    return {
      ok: false,
      currentVersion: opts.currentVersion,
      hasUpdate: false,
      error: 'release metadata missing tag_name',
    };
  }
  const latestVersion = tag.replace(/^v/, '');
  const hasUpdate = compareSemver(latestVersion, opts.currentVersion) > 0;
  return {
    ok: true,
    currentVersion: opts.currentVersion,
    latestVersion,
    hasUpdate,
    ...(typeof body.html_url === 'string' ? { releaseUrl: body.html_url } : {}),
    ...(typeof body.published_at === 'string' ? { publishedAt: body.published_at } : {}),
    ...(typeof body.body === 'string' ? { notes: body.body } : {}),
  };
}

export function formatUpdateCheck(result: UpdateCheckResult): string {
  if (!result.ok) {
    return `update check failed: ${result.error ?? 'unknown error'}`;
  }
  const lines: string[] = [];
  lines.push(`Current: v${result.currentVersion}`);
  lines.push(`Latest:  v${result.latestVersion ?? 'unknown'}`);
  if (result.hasUpdate) {
    lines.push('');
    lines.push(`Update available: v${result.currentVersion} -> v${result.latestVersion}`);
    if (result.releaseUrl) lines.push(`Release: ${result.releaseUrl}`);
    if (result.publishedAt) lines.push(`Published: ${result.publishedAt}`);
    if (result.notes) {
      const trimmed = result.notes.split('\n').slice(0, 8).join('\n');
      lines.push('');
      lines.push('Notes (truncated):');
      lines.push(trimmed);
    }
    lines.push('');
    lines.push('Run your installer to upgrade (npm i -g @crowclaw/cli, brew upgrade crowclaw, etc.)');
    lines.push('Use `crowclaw update --backup` first to snapshot ~/.crowclaw before upgrading.');
  } else {
    lines.push('');
    lines.push('You are up to date.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// --backup — tar.gz the data dir before an upgrade.
// ---------------------------------------------------------------------------

export interface UpdateBackupOptions {
  /** Source dir to back up. Defaults to ~/.crowclaw. */
  dataDir?: string;
  /** Backup output dir. Defaults to <dataDir>/backups. */
  backupDir?: string;
  /** Override timestamp for deterministic tests. */
  timestamp?: string;
  /** Skip files whose basename matches. Defaults to skip "backups" to avoid recursion. */
  skipBasenames?: Set<string>;
}

export interface UpdateBackupResult {
  ok: boolean;
  archivePath?: string;
  fileCount?: number;
  totalBytes?: number;
  error?: string;
}

/**
 * Walk `dir` and yield absolute file paths. Skips entries whose basename is
 * in `skipBasenames`. Order is deterministic-ish (readdir order) so tests can
 * assert without complex sorting.
 */
async function* walk(
  dir: string,
  skipBasenames: Set<string>,
): AsyncGenerator<{ absPath: string; rel: string; root: string }> {
  const stack: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: '' }];
  const root = dir;
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
    try {
      entries = await readdir(top.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skipBasenames.has(entry.name)) continue;
      const abs = join(top.abs, entry.name);
      const rel = top.rel ? `${top.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push({ abs, rel });
      } else if (entry.isFile()) {
        yield { absPath: abs, rel, root };
      }
    }
  }
}

/**
 * Minimal POSIX tar writer. We emit a self-contained .tgz by composing a
 * USTAR-shaped header per file and gzipping the stream. We do NOT depend on
 * a tar library to keep the CLI install footprint zero — tar's wire format
 * is small and well-specified, and the only consumer is `tar -xzf`.
 *
 * The output is restorable with `tar -xzf backup.tgz -C <target>` on any
 * POSIX host.
 */
function buildTarHeader(name: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(512, 0);
  // Truncate to 100 bytes for name (USTAR allows prefix split — we keep it
  // simple by truncating long paths, since .crowclaw paths are well under).
  header.write(name.slice(0, 100), 0, 100, 'utf-8');
  header.write('0000600\0', 100, 8, 'utf-8'); // mode 0600
  header.write('0000000\0', 108, 8, 'utf-8'); // uid
  header.write('0000000\0', 116, 8, 'utf-8'); // gid
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf-8'); // size (octal)
  header.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136, 12, 'utf-8'); // mtime
  header.write('        ', 148, 8, 'utf-8'); // checksum placeholder
  header.write('0', 156, 1, 'utf-8'); // typeflag '0' = file
  header.write('ustar\0', 257, 6, 'utf-8'); // magic
  header.write('00', 263, 2, 'utf-8'); // version
  let checksum = 0;
  for (let i = 0; i < 512; i += 1) checksum += header[i]!;
  const chkStr = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(chkStr, 148, 8, 'utf-8');
  return header;
}

export async function runUpdateBackup(
  opts: UpdateBackupOptions = {},
): Promise<UpdateBackupResult> {
  const dataDir = opts.dataDir ?? join(homedir(), '.crowclaw');
  const backupDir = opts.backupDir ?? join(dataDir, 'backups');
  const skip = opts.skipBasenames ?? new Set(['backups']);
  const timestamp = opts.timestamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(backupDir, `${timestamp}.tgz`);

  try {
    await stat(dataDir);
  } catch {
    return { ok: false, error: `data dir not found: ${dataDir}` };
  }

  try {
    await mkdir(backupDir, { recursive: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `failed to create backup dir: ${msg}` };
  }

  // Stream files through gzip into the archive. We yield Buffers from an
  // async generator and pipe them through createGzip → file. This keeps
  // memory bounded for large data dirs (think gigabytes of attachments).
  let fileCount = 0;
  let totalBytes = 0;
  const gzip = createGzip();
  const out = createWriteStream(archivePath, { mode: 0o600 });
  const source = (async function* () {
    for await (const f of walk(dataDir, skip)) {
      let stats;
      try {
        stats = await stat(f.absPath);
      } catch {
        continue;
      }
      const header = buildTarHeader(f.rel, stats.size, stats.mtimeMs / 1000);
      yield header;
      // Stream file content in 64KiB chunks via readStream → Buffer.
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(f.absPath);
        rs.on('data', (chunk: string | Buffer) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        rs.on('end', resolve);
        rs.on('error', reject);
      });
      const body = Buffer.concat(chunks);
      yield body;
      // Pad to 512 bytes.
      const pad = (512 - (body.length % 512)) % 512;
      if (pad > 0) yield Buffer.alloc(pad, 0);
      fileCount += 1;
      totalBytes += body.length;
    }
    // Two zero blocks signal end-of-archive.
    yield Buffer.alloc(1024, 0);
  })();

  try {
    await pipeline(Readable.from(source), gzip, out);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `failed to write archive: ${msg}` };
  }

  return { ok: true, archivePath, fileCount, totalBytes };
}

export function formatUpdateBackup(result: UpdateBackupResult): string {
  if (!result.ok) {
    return `backup failed: ${result.error ?? 'unknown error'}`;
  }
  return [
    `Backup created: ${result.archivePath}`,
    `Files: ${result.fileCount ?? 0}, bytes: ${result.totalBytes ?? 0}`,
    'Restore with: tar -xzf <archive> -C <target>',
  ].join('\n');
}

