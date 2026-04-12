import { describe, expect, it } from 'vitest';
import { routePaths, localRoute } from '@crowclaw/runtime-node/route-paths';

describe('runtime-node package exports', () => {
  it('exposes route path helpers through the package export surface', () => {
    expect(routePaths.code.bridgeStatus).toBe('/api/code/bridge/status');
    expect(routePaths.code.bridgeProcess).toBe('/api/code/bridge/process');
    expect(routePaths.system.status).toBe('/api/system/status');
    expect(localRoute(routePaths.system.status)).toBe('http://localhost/api/system/status');
  });
});
