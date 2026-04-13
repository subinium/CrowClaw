// ---------------------------------------------------------------------------
// Node API types — loaded via dynamic import() to avoid @types/node dependency.
// The core package targets Cloudflare Workers types at compile time;
// Node APIs are available at runtime from runtime-node / CLI contexts.
// ---------------------------------------------------------------------------

interface NodeFs {
  readFile(path: string, encoding: string): Promise<string>;
}

interface NodePath {
  join(...parts: string[]): string;
  dirname(p: string): string;
  resolve(...parts: string[]): string;
}

let _fs: NodeFs | null = null;
let _path: NodePath | null = null;

// Use variable-based import() to prevent TypeScript from resolving
// the node: specifier at compile time (core targets Workers types).
const FS_MODULE = 'node:fs/promises';
const PATH_MODULE = 'node:path';

async function getNodeFs(): Promise<NodeFs> {
  if (!_fs) _fs = await import(/* @vite-ignore */ FS_MODULE) as unknown as NodeFs;
  return _fs;
}

async function getNodePath(): Promise<NodePath> {
  if (!_path) _path = await import(/* @vite-ignore */ PATH_MODULE) as unknown as NodePath;
  return _path;
}

// ---------------------------------------------------------------------------
// Helpers — portable byte length (avoids direct Buffer reference)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function byteLength(str: string): number {
  return encoder.encode(str).byteLength;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextFile {
  path: string;
  filename: string;
  content: string;
  depth: number; // 0 = working dir, 1 = parent, etc.
  truncated: boolean;
  byteSize: number;
}

export interface ContextEngineOptions {
  workingDirectory: string;
  maxDepth?: number; // default 10
  maxTotalBytes?: number; // default 50_000 (~12k tokens)
  maxFileBytes?: number; // default 10_000
  contextFileNames?: string[]; // default list below
  securityScan?: boolean; // default true
}

export interface ContextEngineResult {
  files: ContextFile[];
  totalBytes: number;
  truncatedFiles: number;
  securityWarnings: string[];
  discoveryDepth: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.crowclaw.md',
  '.hermes.md',
  'CROWCLAW.md',
  'CONTEXT.md',
];

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_TOTAL_BYTES = 50_000;
const DEFAULT_MAX_FILE_BYTES = 10_000;

// ---------------------------------------------------------------------------
// Security scan patterns
// ---------------------------------------------------------------------------

const SECURITY_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?previous/i, label: 'prompt injection: "ignore previous"' },
  { pattern: /^system:/im, label: 'prompt injection: "system:" directive' },
  { pattern: /you\s+are\s+now/i, label: 'prompt injection: "you are now" role override' },
  { pattern: /[A-Za-z0-9+/]{500,}/, label: 'suspicious base64 payload (>500 chars)' },
  { pattern: /`[^`]{10,}`/, label: 'shell injection: backtick command substitution' },
  { pattern: /\$\([^)]+\)/, label: 'shell injection: $() command substitution' },
];

// ---------------------------------------------------------------------------
// ContextEngine
// ---------------------------------------------------------------------------

export class ContextEngine {
  private readonly rawOptions: ContextEngineOptions;
  private options: Required<ContextEngineOptions> | null = null;
  private result: ContextEngineResult | null = null;

  constructor(options: ContextEngineOptions) {
    this.rawOptions = options;
  }

  private async resolveOptions(): Promise<Required<ContextEngineOptions>> {
    if (this.options) return this.options;
    const path = await getNodePath();
    this.options = {
      workingDirectory: path.resolve(this.rawOptions.workingDirectory),
      maxDepth: this.rawOptions.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxTotalBytes: this.rawOptions.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      maxFileBytes: this.rawOptions.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      contextFileNames: this.rawOptions.contextFileNames ?? [...DEFAULT_CONTEXT_FILES],
      securityScan: this.rawOptions.securityScan ?? true,
    };
    return this.options;
  }

  /**
   * Walk from workingDirectory upward, discovering context files.
   * Closest files (depth 0) take priority when budgeting bytes.
   * Files are returned ordered deepest-first (root -> working dir)
   * so that local files appear last (highest priority in prompt).
   */
  async discover(): Promise<ContextEngineResult> {
    const opts = await this.resolveOptions();
    const fs = await getNodeFs();
    const path = await getNodePath();

    const files: ContextFile[] = [];
    const securityWarnings: string[] = [];
    let totalBytes = 0;
    let truncatedFiles = 0;
    let maxDiscoveryDepth = 0;

    // Collect candidates at each depth level (0 = working dir, 1 = parent, ...)
    let currentDir = opts.workingDirectory;
    const visited = new Set<string>();

    for (let depth = 0; depth <= opts.maxDepth; depth++) {
      const resolvedDir = path.resolve(currentDir);

      // Prevent infinite loop at filesystem root
      if (visited.has(resolvedDir)) break;
      visited.add(resolvedDir);

      for (const filename of opts.contextFileNames) {
        const filePath = path.join(resolvedDir, filename);

        let raw: string;
        try {
          raw = await fs.readFile(filePath, 'utf-8');
        } catch (error: unknown) {
          // Skip missing files and permission errors gracefully
          const code = (error as { code?: string }).code;
          if (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES') {
            continue;
          }
          // Re-throw unexpected errors
          throw error;
        }

        const rawByteSize = byteLength(raw);

        // Security scan
        if (opts.securityScan) {
          const warnings = this.scanForSecurity(raw, filePath);
          securityWarnings.push(...warnings);
        }

        // Truncate if file exceeds per-file limit
        const { content, truncated } = this.truncate(raw, opts.maxFileBytes);
        if (truncated) truncatedFiles++;

        const contentByteSize = byteLength(content);

        // Check total budget — skip if would exceed
        if (totalBytes + contentByteSize > opts.maxTotalBytes) {
          continue;
        }

        totalBytes += contentByteSize;
        if (depth > maxDiscoveryDepth) maxDiscoveryDepth = depth;

        files.push({
          path: filePath,
          filename,
          content,
          depth,
          truncated,
          byteSize: truncated ? contentByteSize : rawByteSize,
        });
      }

      // Move to parent directory
      const parentDir = path.dirname(resolvedDir);
      if (parentDir === resolvedDir) break; // reached filesystem root
      currentDir = parentDir;
    }

    // Sort deepest-first (highest depth first) so root context appears
    // at the top of the prompt and local context appears last (overrides).
    files.sort((a, b) => b.depth - a.depth);

    this.result = {
      files,
      totalBytes,
      truncatedFiles,
      securityWarnings,
      discoveryDepth: maxDiscoveryDepth,
    };

    return this.result;
  }

  /**
   * Scan content for potential security issues:
   * - Prompt injection patterns ("ignore previous", "system:", etc.)
   * - Encoded payloads (base64 blocks > 500 chars)
   * - Shell command injection (backtick commands, $() substitution)
   */
  private scanForSecurity(content: string, path: string): string[] {
    const warnings: string[] = [];
    for (const { pattern, label } of SECURITY_PATTERNS) {
      if (pattern.test(content)) {
        warnings.push(`[${path}] ${label}`);
      }
    }
    return warnings;
  }

  /**
   * Truncate content to maxBytes, preserving complete lines.
   * Adds "[truncated]" marker at the end.
   */
  private truncate(
    content: string,
    maxBytes: number,
  ): { content: string; truncated: boolean } {
    const size = byteLength(content);
    if (size <= maxBytes) {
      return { content, truncated: false };
    }

    // Walk lines, accumulating bytes until we exceed the budget
    const lines = content.split('\n');
    let accumulated = 0;
    const kept: string[] = [];

    for (const line of lines) {
      const lineBytes = byteLength(line + '\n');
      if (accumulated + lineBytes > maxBytes) break;
      accumulated += lineBytes;
      kept.push(line);
    }

    return {
      content: kept.join('\n') + '\n[truncated]',
      truncated: true,
    };
  }

  /**
   * Format discovered context files into a prompt section.
   * Closest (depth 0) files appear last (highest priority).
   * Must call discover() first.
   */
  formatForPrompt(): string {
    if (!this.result) {
      throw new Error('Must call discover() before formatForPrompt()');
    }
    return formatContextForPrompt(this.result);
  }
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

/**
 * Load context files by walking from workingDirectory upward.
 */
export async function loadContextFiles(
  workingDirectory: string,
  options?: Partial<ContextEngineOptions>,
): Promise<ContextEngineResult> {
  const engine = new ContextEngine({ workingDirectory, ...options });
  return engine.discover();
}

/**
 * Format a ContextEngineResult into a prompt section string.
 * Files are already sorted deepest-first, so local (depth 0) appears last.
 */
export function formatContextForPrompt(result: ContextEngineResult): string {
  if (result.files.length === 0) return '';

  const sections: string[] = [];

  // Header with metadata
  sections.push(
    `# Context Files (${result.files.length} discovered, ${result.discoveryDepth} levels deep)`,
  );

  if (result.securityWarnings.length > 0) {
    sections.push('');
    sections.push('## Security Warnings');
    for (const warning of result.securityWarnings) {
      sections.push(`- ${warning}`);
    }
  }

  if (result.truncatedFiles > 0) {
    sections.push('');
    sections.push(`> ${result.truncatedFiles} file(s) were truncated to fit context budget.`);
  }

  // File contents — already ordered deepest-first
  for (const file of result.files) {
    sections.push('');
    sections.push(`## ${file.filename} (depth ${file.depth})`);
    sections.push(`<!-- source: ${file.path} -->`);
    sections.push('');
    sections.push(file.content);
  }

  return sections.join('\n');
}
