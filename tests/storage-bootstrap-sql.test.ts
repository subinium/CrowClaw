import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bootstrapSql } from '@crowclaw/storage';

describe('storage bootstrap SQL artifact', () => {
  it('matches the exported bootstrap SQL string', () => {
    const fileSql = readFileSync('packages/storage/sql/bootstrap.sql', 'utf8').trim();
    expect(fileSql).toBe(bootstrapSql.trim());
    expect(fileSql).toContain('scope_key TEXT');
  });
});
