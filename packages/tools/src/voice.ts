import type { ToolDefinition, ToolExecutionResult } from '@crowclaw/core';

// ---------------------------------------------------------------------------
// TTS (Text-to-Speech) Tool
// ---------------------------------------------------------------------------

export interface TtsToolOptions {
  /** OpenAI-compatible TTS API base URL */
  providerBaseUrl?: string;
  apiKey?: string;
  /** Default voice (alloy, echo, fable, onyx, nova, shimmer for OpenAI) */
  defaultVoice?: string;
  /** Default model (tts-1 or tts-1-hd for OpenAI) */
  defaultModel?: string;
  /** Alternative: use edge-tts CLI if available */
  useEdgeTts?: boolean;
}

export function createTtsTool(options?: TtsToolOptions): ToolDefinition {
  return {
    manifest: {
      name: 'voice.tts',
      description: 'Converts text to speech audio. Returns audio data or a file path.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'low'
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const text = typeof input.text === 'string' ? input.text : '';
      const voice = typeof input.voice === 'string' ? input.voice : (options?.defaultVoice ?? 'alloy');
      const model = typeof input.model === 'string' ? input.model : (options?.defaultModel ?? 'tts-1');
      const outputPath = typeof input.outputPath === 'string' ? input.outputPath : undefined;

      if (!text) {
        return { toolName: 'voice.tts', runtime: 'worker', ok: false, output: 'Missing text parameter.' };
      }

      // Try edge-tts CLI first if configured
      if (options?.useEdgeTts) {
        try {
          const { spawn } = await import('node:child_process');
          const outFile = outputPath ?? `/tmp/crowclaw-tts-${Date.now()}.mp3`;

          return new Promise<ToolExecutionResult>((resolve) => {
            const args = ['--text', text, '--voice', voice, '--write-media', outFile];
            const child = spawn('edge-tts', args, { stdio: ['ignore', 'pipe', 'pipe'] });

            let stderr = '';
            child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

            child.on('error', () => {
              resolve({
                toolName: 'voice.tts',
                runtime: 'worker',
                ok: false,
                output: 'edge-tts not found. Install with: pip install edge-tts',
                metadata: { backend: 'edge-tts' }
              });
            });

            child.on('close', (code) => {
              if (code === 0) {
                resolve({
                  toolName: 'voice.tts',
                  runtime: 'worker',
                  ok: true,
                  output: `Audio saved to ${outFile}`,
                  metadata: { path: outFile, voice, backend: 'edge-tts', textLength: text.length }
                });
              } else {
                resolve({
                  toolName: 'voice.tts',
                  runtime: 'worker',
                  ok: false,
                  output: `edge-tts failed: ${stderr}`,
                  metadata: { backend: 'edge-tts' }
                });
              }
            });
          });
        } catch {
          // Fall through to API
        }
      }

      // Try OpenAI-compatible TTS API
      const apiKey = options?.apiKey;
      const baseUrl = options?.providerBaseUrl ?? 'https://api.openai.com/v1';

      if (apiKey) {
        try {
          const response = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/speech`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' }),
            signal: context.signal
          });

          if (!response.ok) {
            return {
              toolName: 'voice.tts',
              runtime: 'worker',
              ok: false,
              output: `TTS API failed: ${response.status} ${response.statusText}`,
              metadata: { model, voice }
            };
          }

          if (outputPath) {
            const { writeFile } = await import('node:fs/promises');
            const buffer = Buffer.from(await response.arrayBuffer());
            await writeFile(outputPath, buffer);
            return {
              toolName: 'voice.tts',
              runtime: 'worker',
              ok: true,
              output: `Audio saved to ${outputPath} (${Math.round(buffer.length / 1024)}KB)`,
              metadata: { path: outputPath, model, voice, sizeBytes: buffer.length, backend: 'openai-api' }
            };
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          return {
            toolName: 'voice.tts',
            runtime: 'worker',
            ok: true,
            output: `Generated ${Math.round(buffer.length / 1024)}KB audio (${model}, voice: ${voice})`,
            metadata: { model, voice, sizeBytes: buffer.length, backend: 'openai-api', textLength: text.length }
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return { toolName: 'voice.tts', runtime: 'worker', ok: false, output: `TTS failed: ${msg}` };
        }
      }

      // No backend available
      return {
        toolName: 'voice.tts',
        runtime: 'worker',
        ok: false,
        output: `TTS requires either edge-tts CLI or an OpenAI-compatible API key.\nText: "${text.slice(0, 100)}..."`,
        metadata: { simulated: true, textLength: text.length }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Transcription (Speech-to-Text) Tool
// ---------------------------------------------------------------------------

export interface TranscriptionToolOptions {
  providerBaseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
}

export function createTranscriptionTool(options?: TranscriptionToolOptions): ToolDefinition {
  return {
    manifest: {
      name: 'voice.transcribe',
      description: 'Transcribes audio from a file path or URL to text.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'low'
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const filePath = typeof input.filePath === 'string' ? input.filePath : '';
      const url = typeof input.url === 'string' ? input.url : '';
      const language = typeof input.language === 'string' ? input.language : undefined;
      const model = typeof input.model === 'string' ? input.model : (options?.defaultModel ?? 'whisper-1');

      if (!filePath && !url) {
        return { toolName: 'voice.transcribe', runtime: 'worker', ok: false, output: 'Missing filePath or url parameter.' };
      }

      const apiKey = options?.apiKey;
      const baseUrl = options?.providerBaseUrl ?? 'https://api.openai.com/v1';

      if (!apiKey) {
        return {
          toolName: 'voice.transcribe',
          runtime: 'worker',
          ok: false,
          output: 'Transcription requires an OpenAI-compatible API key.',
          metadata: { simulated: true }
        };
      }

      try {
        let audioData: ArrayBuffer;
        let fileName: string;

        if (filePath) {
          const { readFile } = await import('node:fs/promises');
          const buffer = await readFile(filePath);
          audioData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
          fileName = filePath.split('/').pop() ?? 'audio.mp3';
        } else {
          const response = await fetch(url, { signal: context.signal });
          audioData = await response.arrayBuffer();
          fileName = url.split('/').pop()?.split('?')[0] ?? 'audio.mp3';
        }

        const formData = new FormData();
        formData.append('file', new Blob([audioData]), fileName);
        formData.append('model', model);
        if (language) formData.append('language', language);

        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
          signal: context.signal
        });

        if (!response.ok) {
          return {
            toolName: 'voice.transcribe',
            runtime: 'worker',
            ok: false,
            output: `Transcription API failed: ${response.status} ${response.statusText}`,
            metadata: { model }
          };
        }

        const result = await response.json() as { text?: string };
        return {
          toolName: 'voice.transcribe',
          runtime: 'worker',
          ok: true,
          output: result.text ?? '',
          metadata: { model, language, source: filePath || url, textLength: (result.text ?? '').length }
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { toolName: 'voice.transcribe', runtime: 'worker', ok: false, output: `Transcription failed: ${msg}` };
      }
    }
  };
}
