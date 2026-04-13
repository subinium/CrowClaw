/**
 * Config Schema API client for CrowClaw dashboard.
 *
 * Fetches the runtime config schema and validates updates before submission.
 * Used by dashboard form components to render schema-driven editors.
 */

import { api } from './api.js';

// ---------------------------------------------------------------------------
// Re-export types needed by dashboard components
// ---------------------------------------------------------------------------

export interface ConfigFieldSchema {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  label: string;
  description: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
  min?: number;
  max?: number;
  sensitive?: boolean;
  section: string;
}

export interface ConfigSectionSchema {
  id: string;
  label: string;
  description: string;
  fields: ConfigFieldSchema[];
}

export interface FullConfigSchema {
  version: string;
  sections: ConfigSectionSchema[];
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string; value?: unknown }>;
}

// ---------------------------------------------------------------------------
// API interface
// ---------------------------------------------------------------------------

export interface ConfigSchemaApi {
  getSchema(): Promise<FullConfigSchema>;
  validateUpdate(section: string, data: Record<string, unknown>): Promise<ValidationResult>;
}

/**
 * Create a config schema API client.
 *
 * @param baseUrl - Optional base URL override for testing or SSR contexts.
 *                  In the browser, defaults to the current origin.
 */
export const createConfigSchemaApi = (baseUrl?: string): ConfigSchemaApi => {
  const fetchSchema = async (path: string, options?: RequestInit) => {
    if (baseUrl) {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(options?.headers as Record<string, string>),
        },
      });
      return response.json();
    }
    return api(path, options);
  };

  return {
    async getSchema(): Promise<FullConfigSchema> {
      return fetchSchema('/api/config/schema') as Promise<FullConfigSchema>;
    },

    async validateUpdate(
      section: string,
      data: Record<string, unknown>,
    ): Promise<ValidationResult> {
      return fetchSchema('/api/config/validate', {
        method: 'POST',
        body: JSON.stringify({ section, data }),
      }) as Promise<ValidationResult>;
    },
  };
};
