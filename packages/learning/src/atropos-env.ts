import type { TrajectoryEntry } from './trajectory.js';
import { scoreTrajectory } from './trajectory-scorer.js';

export interface AtroposEnvConfig {
  baseUrl: string;
  environment: string;
  apiKey?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface AtroposPrompt {
  id: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface AtroposRegistration {
  environment: string;
  ok: boolean;
  raw?: unknown;
}

export interface AtroposRollout {
  promptId: string;
  prompt: string;
  response: string;
  reward?: number;
  trajectory?: TrajectoryEntry;
  metadata?: Record<string, unknown>;
}

export interface AtroposSubmitResult {
  ok: boolean;
  raw?: unknown;
}

export type AtroposRewardFn = (trajectory: TrajectoryEntry) => number;

export function defaultAtroposReward(trajectory: TrajectoryEntry): number {
  return scoreTrajectory(trajectory).overall;
}

export class AtroposEnv {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AtroposEnvConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
  }

  async register(metadata: Record<string, unknown> = {}): Promise<AtroposRegistration> {
    const raw = await this.request('/register_environment', {
      environment: this.config.environment,
      metadata,
    });
    return { environment: this.config.environment, ok: true, raw };
  }

  async getBatch(count = 1): Promise<AtroposPrompt[]> {
    const raw = await this.request('/get_batch', {
      environment: this.config.environment,
      count,
    });
    const prompts = Array.isArray((raw as { prompts?: unknown }).prompts)
      ? (raw as { prompts: unknown[] }).prompts
      : Array.isArray(raw)
        ? raw as unknown[]
        : [];
    return prompts
      .map((item, index) => normalizeAtroposPrompt(item, index))
      .filter((prompt): prompt is AtroposPrompt => prompt !== null);
  }

  async fetchPrompt(): Promise<AtroposPrompt | null> {
    return (await this.getBatch(1))[0] ?? null;
  }

  async submitRollout(rollout: AtroposRollout): Promise<AtroposSubmitResult> {
    const raw = await this.request('/batch_completions', {
      environment: this.config.environment,
      completions: [{
        prompt_id: rollout.promptId,
        prompt: rollout.prompt,
        response: rollout.response,
        reward: rollout.reward ?? (rollout.trajectory ? defaultAtroposReward(rollout.trajectory) : undefined),
        trajectory: rollout.trajectory,
        metadata: rollout.metadata,
      }],
    });
    return { ok: true, raw };
  }

  private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Atropos ${path} failed with ${response.status}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) as unknown : {};
  }
}

function normalizeAtroposPrompt(item: unknown, index: number): AtroposPrompt | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const prompt = typeof obj.prompt === 'string'
    ? obj.prompt
    : typeof obj.text === 'string'
      ? obj.text
      : typeof obj.message === 'string'
        ? obj.message
        : '';
  if (!prompt) return null;
  return {
    id: typeof obj.id === 'string' ? obj.id : typeof obj.prompt_id === 'string' ? obj.prompt_id : `atropos-${index}`,
    prompt,
    metadata: obj.metadata && typeof obj.metadata === 'object' ? obj.metadata as Record<string, unknown> : undefined,
  };
}
