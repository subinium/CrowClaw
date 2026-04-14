import { describe, it, expect } from 'vitest';
import { sanitizeEnv } from '../packages/core/src/index.js';

describe('sanitizeEnv', () => {
  describe('strips sensitive variable patterns', () => {
    it('strips vars matching API_KEY pattern', () => {
      const result = sanitizeEnv({ MY_API_KEY: 'secret', PATH: '/usr/bin' });
      expect(result).toEqual({ PATH: '/usr/bin' });
    });

    it('strips vars matching SECRET pattern', () => {
      const result = sanitizeEnv({ AWS_SECRET_KEY: 'abc', HOME: '/home/user' });
      expect(result).toEqual({ HOME: '/home/user' });
    });

    it('strips vars matching TOKEN pattern', () => {
      const result = sanitizeEnv({ AUTH_TOKEN: 'tok123', NODE_ENV: 'production' });
      expect(result).toEqual({ NODE_ENV: 'production' });
    });

    it('strips vars matching PASSWORD pattern', () => {
      const result = sanitizeEnv({ DB_PASSWORD: 'pw', USER: 'admin' });
      expect(result).toEqual({ USER: 'admin' });
    });

    it('strips vars matching CREDENTIAL pattern', () => {
      const result = sanitizeEnv({ SERVICE_CREDENTIAL: 'cred', LANG: 'en_US' });
      expect(result).toEqual({ LANG: 'en_US' });
    });
  });

  describe('strips known provider and platform vars', () => {
    it('strips OPENAI_* vars', () => {
      const result = sanitizeEnv({ OPENAI_API_KEY: 'sk-xxx', PATH: '/usr/bin' });
      expect(result).toEqual({ PATH: '/usr/bin' });
    });

    it('strips ANTHROPIC_* vars', () => {
      const result = sanitizeEnv({ ANTHROPIC_API_KEY: 'ant-xxx', HOME: '/home' });
      expect(result).toEqual({ HOME: '/home' });
    });

    it('strips OPENROUTER_* vars', () => {
      const result = sanitizeEnv({ OPENROUTER_KEY: 'or-xxx', NODE_ENV: 'test' });
      expect(result).toEqual({ NODE_ENV: 'test' });
    });

    it('strips CROWCLAW_DASHBOARD_TOKEN', () => {
      const result = sanitizeEnv({ CROWCLAW_DASHBOARD_TOKEN: 'dashtoken', USER: 'me' });
      expect(result).toEqual({ USER: 'me' });
    });

    it('strips GH_TOKEN', () => {
      const result = sanitizeEnv({ GH_TOKEN: 'ghp_xxx', PATH: '/bin' });
      expect(result).toEqual({ PATH: '/bin' });
    });

    it('strips GITHUB_TOKEN', () => {
      const result = sanitizeEnv({ GITHUB_TOKEN: 'ghp_yyy', HOME: '/root' });
      expect(result).toEqual({ HOME: '/root' });
    });
  });

  describe('keeps safe variables', () => {
    it('keeps PATH, HOME, NODE_ENV, USER', () => {
      const env = {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/home/user',
        NODE_ENV: 'production',
        USER: 'developer',
      };
      const result = sanitizeEnv(env);
      expect(result).toEqual(env);
    });
  });

  describe('edge cases', () => {
    it('returns undefined for null input', () => {
      expect(sanitizeEnv(null as unknown as undefined)).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(sanitizeEnv(undefined)).toBeUndefined();
    });

    it('returns undefined for empty object after stripping all sensitive vars', () => {
      const result = sanitizeEnv({
        API_KEY: 'secret',
        OPENAI_API_KEY: 'sk-xxx',
        DB_PASSWORD: 'pw',
      });
      expect(result).toBeUndefined();
    });
  });
});
