/**
 * v0.9.0 (#325) — Piper local TTS provider. Piper (https://github.com/rhasspy/piper)
 * is a self-hosted neural TTS that runs ONNX models on CPU. Hermes v0.12 #17885
 * shipped Piper as the canonical "no API key required" provider so contributors
 * could exercise the TTS surface without signing up for anything.
 *
 * Wire shape:
 *   piper --model /path/to/voice.onnx --output_file - < input.txt
 *
 * stdin → text, stdout → raw WAV (16-bit PCM). We capture stdout, leaving
 * stderr for diagnostics on failure.
 *
 * Configuration:
 *  - `modelPath`: required ONNX model file. Voices are downloaded out-of-band
 *    (e.g. via `huggingface-cli` or `piper-tts` setup). We do *not* bundle
 *    voices in the npm package — they're 30-100MB each.
 *  - `binaryPath`: defaults to `piper` (PATH lookup); override for users who
 *    installed via `pipx` or a non-standard path.
 *
 * Health check: spawn `piper --help` with a 3-second timeout. If that fails
 * we surface a `{ ok: false }` so `crowclaw tts list` shows piper as not-ready
 * with the actual reason ("piper binary not found", etc).
 */

import type { TTSProvider, TTSSynthesisOptions, TTSSynthesisResult } from './tts-registry.js';

export interface PiperProviderOptions {
  /** Absolute path to a Piper ONNX voice model file (e.g. en_US-amy-low.onnx). */
  modelPath: string;
  /** Override the binary name/path. Defaults to `'piper'` (PATH lookup). */
  binaryPath?: string;
  /** Override the display name. Defaults to a label derived from the model. */
  displayName?: string;
  /** Override the voice ID exposed via `listVoices`. Defaults to the model
   * basename (without `.onnx`). */
  voiceId?: string;
}

export function createPiperProvider(options: PiperProviderOptions): TTSProvider {
  const binary = options.binaryPath ?? 'piper';
  const modelPath = options.modelPath;
  if (!modelPath) {
    // Surfacing this at construction time is intentional: a missing modelPath
    // is a config bug, not a runtime degradation, and we want it loud.
    throw new Error('createPiperProvider requires `modelPath`');
  }
  const voiceId = options.voiceId ?? deriveVoiceId(modelPath);
  const displayName = options.displayName ?? `Piper (${voiceId})`;

  return {
    name: 'piper',
    displayName,

    listVoices: async () => [{ voiceId, displayName, language: undefined, cloned: false }],

    health: async () => {
      // Probe with `--help`. Piper prints usage to stdout and exits 0, so
      // we don't need to parse anything — non-zero or spawn error → not ready.
      const probe = await spawnAndCapture(binary, ['--help'], undefined, 3_000);
      if (probe.spawnError) {
        return {
          ok: false,
          detail: probe.spawnError.code === 'ENOENT'
            ? `piper binary not found on PATH (set binaryPath in PiperProviderOptions or install piper)`
            : `piper --help failed: ${probe.spawnError.message}`,
        };
      }
      if (probe.exitCode !== 0) {
        return { ok: false, detail: `piper --help exited ${probe.exitCode}` };
      }
      return { ok: true, detail: `piper binary OK (model: ${modelPath})` };
    },

    synthesize: async (text: string, opts: TTSSynthesisOptions): Promise<TTSSynthesisResult> => {
      if (!text) {
        throw new Error('Piper synthesize() requires non-empty text');
      }
      const resolvedVoice = opts.voiceId ?? voiceId;
      const args = ['--model', modelPath, '--output_file', '-'];
      const result = await spawnAndCapture(binary, args, text, opts.signal);
      if (result.spawnError) {
        // ENOENT = binary missing. Per AC, return a clear error so the
        // tool envelope surfaces "Missing piper binary → graceful error".
        if (result.spawnError.code === 'ENOENT') {
          throw new Error(`Piper binary not found (looked for '${binary}'). Install piper and ensure it's on PATH.`);
        }
        throw new Error(`Piper spawn failed: ${result.spawnError.message}`);
      }
      if (result.exitCode !== 0) {
        throw new Error(`Piper exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
      }
      if (result.stdout.length === 0) {
        // Piper succeeded but produced no audio. The most common cause is a
        // malformed ONNX model — surface that, don't return empty bytes.
        throw new Error('Piper returned empty audio (model likely incompatible or input filtered)');
      }
      return {
        audio: result.stdout,
        // Piper emits WAV by default (16-bit PCM, 22050 Hz). Documented in
        // their README. We hardcode the mime; if Piper adds output_format
        // flags later we can branch on `opts.format`.
        mime: 'audio/wav',
        voiceId: resolvedVoice,
        model: modelPath,
        provider: 'piper',
        metadata: { bytes: result.stdout.length, binary },
      };
    },
  };
}

function deriveVoiceId(modelPath: string): string {
  // Strip directory and `.onnx` extension. Result is the canonical voice
  // identifier (e.g. `en_US-amy-low`).
  const file = modelPath.split(/[\\/]/).pop() ?? modelPath;
  return file.replace(/\.onnx$/i, '');
}

interface SpawnCaptureResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number | null;
  spawnError?: NodeJS.ErrnoException;
}

/**
 * Spawn `cmd args`, optionally write `stdin` to it, and capture stdout/stderr.
 *
 * `stdin`:
 *   - `undefined` → close stdin immediately (for `--help` style probes)
 *   - `string`    → write the string as UTF-8 then end
 *
 * `signalOrTimeout`:
 *   - `AbortSignal` → wire up cancellation; child is killed when signal aborts.
 *   - `number`      → install a setTimeout that kills the child after N ms.
 *     Used for the health probe so a hung binary doesn't pin the registry.
 *   - `undefined`   → no timeout, no cancellation.
 */
async function spawnAndCapture(
  cmd: string,
  args: string[],
  stdin: string | undefined,
  signalOrTimeout?: AbortSignal | number,
): Promise<SpawnCaptureResult> {
  let cpModule: typeof import('node:child_process');
  try {
    cpModule = await import('node:child_process');
  } catch {
    // Cloudflare Workers / other runtime — Piper not usable there. We
    // surface this as a spawnError so the health/synth call returns the
    // expected shape and the registry handler can route accordingly.
    return {
      stdout: new Uint8Array(),
      stderr: '',
      exitCode: null,
      spawnError: Object.assign(new Error('child_process unavailable'), { code: 'ENOSYS' }) as NodeJS.ErrnoException,
    };
  }

  return new Promise<SpawnCaptureResult>((resolve) => {
    const child = cpModule.spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let stderrText = '';
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    const settle = (result: SpawnCaptureResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => { stderrText += chunk.toString(); });

    child.on('error', (err) => {
      settle({
        stdout: new Uint8Array(),
        stderr: stderrText,
        exitCode: null,
        spawnError: err as NodeJS.ErrnoException,
      });
    });
    child.on('close', (code) => {
      settle({
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderrText,
        exitCode: code,
      });
    });

    // Wire up cancellation / timeout.
    if (signalOrTimeout instanceof AbortSignal) {
      const onAbort = (): void => {
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
      };
      if (signalOrTimeout.aborted) onAbort();
      else signalOrTimeout.addEventListener('abort', onAbort, { once: true });
    } else if (typeof signalOrTimeout === 'number') {
      timeoutHandle = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
      }, signalOrTimeout);
    }

    // Feed stdin and close it. Piper consumes the full stream before emitting
    // any audio, so closing here is correct.
    if (typeof stdin === 'string') {
      try {
        child.stdin?.write(stdin);
      } catch {
        // EPIPE — child already crashed; close handler will fire shortly.
      }
    }
    try {
      child.stdin?.end();
    } catch { /* same — close handler will fire */ }
  });
}
