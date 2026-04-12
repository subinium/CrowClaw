import { describe, expect, it } from 'vitest';
import { PlaywrightBrowserBackend, isPlaywrightAvailable } from '@crowclaw/sandbox-executor';

describe('PlaywrightBrowserBackend', () => {
  it('reports playwright availability', () => {
    // In test environment, playwright may or may not be installed
    const available = isPlaywrightAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('creates backend instance', () => {
    const backend = new PlaywrightBrowserBackend();
    expect(backend.isLaunched()).toBe(false);
  });

  it('throws helpful error if playwright not installed and launch attempted', async () => {
    // This test only runs when playwright is NOT installed
    if (isPlaywrightAvailable()) return;

    const backend = new PlaywrightBrowserBackend();
    await expect(backend.launch()).rejects.toThrow(/[Pp]laywright/);
  });

  it('ensurePage throws when not launched', async () => {
    const backend = new PlaywrightBrowserBackend();
    await expect(backend.goto('https://example.com')).rejects.toThrow('Browser not launched');
  });
});
