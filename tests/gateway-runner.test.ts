import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GatewayRunner,
  type GatewayRunnerConfig,
  type GatewayStatus,
  type NormalizedInboundMessage,
} from '../packages/gateway/src/runner.js';
import { parseCliArgs } from '../packages/cli/src/index.js';

// ---------------------------------------------------------------------------
// Mock fetch globally to avoid real network calls
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockGetMeResponse(username = 'test_bot') {
  return new Response(
    JSON.stringify({ ok: true, result: { id: 123, username, first_name: 'Test Bot' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeMockGetUpdatesResponse(updates: Array<{ update_id: number; message?: { message_id: number; chat: { id: number }; from: { id: number; username: string }; text: string; date: number } }> = []) {
  return new Response(
    JSON.stringify({ ok: true, result: updates }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// GatewayRunner construction
// ---------------------------------------------------------------------------

describe('GatewayRunner', () => {
  it('should construct with config', () => {
    const config: GatewayRunnerConfig = {
      platforms: [{ name: 'telegram', token: 'test-token', enabled: true }],
    };
    const runner = new GatewayRunner(config);
    expect(runner).toBeDefined();
    expect(runner.isRunning()).toBe(false);
    expect(runner.getStatus()).toEqual([]);
  });

  it('should construct with empty platforms', () => {
    const runner = new GatewayRunner({ platforms: [] });
    expect(runner.isRunning()).toBe(false);
    expect(runner.getStatus()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Start with no platforms
  // -------------------------------------------------------------------------

  it('should start with no platforms and return empty status', async () => {
    const runner = new GatewayRunner({ platforms: [] });
    const statuses = await runner.start();
    expect(statuses).toEqual([]);
    expect(runner.isRunning()).toBe(true);
    await runner.stop();
  });

  // -------------------------------------------------------------------------
  // Start with Telegram (mock getMe success)
  // -------------------------------------------------------------------------

  it('should start Telegram and report connected status with bot name', async () => {
    // First call: getMe, Second call: getUpdates (will be called in poll loop)
    mockFetch
      .mockResolvedValueOnce(makeMockGetMeResponse('my_cool_bot'))
      .mockResolvedValue(makeMockGetUpdatesResponse([]));

    const runner = new GatewayRunner({
      platforms: [{ name: 'telegram', token: 'fake-token-123', enabled: true }],
      pollIntervalMs: 50000, // Large interval to prevent rapid polling in test
    });

    const statuses = await runner.start();

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual({
      platform: 'telegram',
      connected: true,
      botName: '@my_cool_bot',
    });

    expect(runner.isRunning()).toBe(true);

    // Verify getMe was called
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/botfake-token-123/getMe',
    );

    await runner.stop();
    expect(runner.isRunning()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Start with Telegram (mock getMe failure)
  // -------------------------------------------------------------------------

  it('should report error when Telegram token is invalid', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, description: 'Unauthorized' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );

    const runner = new GatewayRunner({
      platforms: [{ name: 'telegram', token: 'invalid-token', enabled: true }],
    });

    const statuses = await runner.start();

    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.platform).toBe('telegram');
    expect(statuses[0]!.connected).toBe(false);
    expect(statuses[0]!.error).toBe('Invalid bot token');

    await runner.stop();
  });

  // -------------------------------------------------------------------------
  // Disabled platforms
  // -------------------------------------------------------------------------

  it('should skip disabled platforms', async () => {
    const runner = new GatewayRunner({
      platforms: [{ name: 'telegram', token: 'token', enabled: false }],
    });

    const statuses = await runner.start();

    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.connected).toBe(false);
    expect(statuses[0]!.error).toBe('disabled');
    expect(mockFetch).not.toHaveBeenCalled();

    await runner.stop();
  });

  // -------------------------------------------------------------------------
  // Unsupported platforms show appropriate messages
  // -------------------------------------------------------------------------

  it('should show "requires discord.js" for discord', async () => {
    const runner = new GatewayRunner({
      platforms: [{ name: 'discord', token: 'token', enabled: true }],
    });

    const statuses = await runner.start();
    expect(statuses[0]!.platform).toBe('discord');
    expect(statuses[0]!.connected).toBe(false);
    expect(statuses[0]!.error).toBe('requires discord.js');

    await runner.stop();
  });

  it('should show webhook required for slack', async () => {
    const runner = new GatewayRunner({
      platforms: [{ name: 'slack', token: 'token', enabled: true }],
    });

    const statuses = await runner.start();
    expect(statuses[0]!.platform).toBe('slack');
    expect(statuses[0]!.connected).toBe(false);
    expect(statuses[0]!.error).toContain('webhook');

    await runner.stop();
  });

  it('should show "coming soon" for unknown platforms', async () => {
    const runner = new GatewayRunner({
      platforms: [{ name: 'whatsapp', token: 'token', enabled: true }],
    });

    const statuses = await runner.start();
    expect(statuses[0]!.platform).toBe('whatsapp');
    expect(statuses[0]!.connected).toBe(false);
    expect(statuses[0]!.error).toBe('coming soon');

    await runner.stop();
  });

  // -------------------------------------------------------------------------
  // Stop clears all listeners
  // -------------------------------------------------------------------------

  it('should clear all listeners on stop', async () => {
    mockFetch
      .mockResolvedValueOnce(makeMockGetMeResponse())
      .mockResolvedValue(makeMockGetUpdatesResponse([]));

    const runner = new GatewayRunner({
      platforms: [{ name: 'telegram', token: 'token', enabled: true }],
      pollIntervalMs: 50000,
    });

    await runner.start();
    expect(runner.isRunning()).toBe(true);

    await runner.stop();
    expect(runner.isRunning()).toBe(false);

    // Status should show disconnected after stop
    const status = runner.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]!.connected).toBe(false);
  });

  // -------------------------------------------------------------------------
  // getStatus returns correct shape
  // -------------------------------------------------------------------------

  it('should return correct GatewayStatus shape', async () => {
    mockFetch
      .mockResolvedValueOnce(makeMockGetMeResponse('shape_bot'))
      .mockResolvedValue(makeMockGetUpdatesResponse([]));

    const runner = new GatewayRunner({
      platforms: [
        { name: 'telegram', token: 'token', enabled: true },
        { name: 'discord', token: 'token', enabled: true },
      ],
      pollIntervalMs: 50000,
    });

    await runner.start();
    const statuses = runner.getStatus();

    expect(statuses).toHaveLength(2);

    // Verify shape of each status
    for (const status of statuses) {
      expect(status).toHaveProperty('platform');
      expect(status).toHaveProperty('connected');
      expect(typeof status.platform).toBe('string');
      expect(typeof status.connected).toBe('boolean');
      if (status.error !== undefined) {
        expect(typeof status.error).toBe('string');
      }
      if (status.botName !== undefined) {
        expect(typeof status.botName).toBe('string');
      }
    }

    await runner.stop();
  });

  // -------------------------------------------------------------------------
  // Telegram getMe mock extracts bot name
  // -------------------------------------------------------------------------

  it('should extract bot name from Telegram getMe response', async () => {
    mockFetch
      .mockResolvedValueOnce(makeMockGetMeResponse('extracted_name_bot'))
      .mockResolvedValue(makeMockGetUpdatesResponse([]));

    const runner = new GatewayRunner({
      platforms: [{ name: 'telegram', token: 'token', enabled: true }],
      pollIntervalMs: 50000,
    });

    const statuses = await runner.start();
    expect(statuses[0]!.botName).toBe('@extracted_name_bot');

    await runner.stop();
  });

  // -------------------------------------------------------------------------
  // Multiple starts should be idempotent
  // -------------------------------------------------------------------------

  it('should not restart if already running', async () => {
    mockFetch
      .mockResolvedValueOnce(makeMockGetMeResponse())
      .mockResolvedValue(makeMockGetUpdatesResponse([]));

    const runner = new GatewayRunner({
      platforms: [{ name: 'telegram', token: 'token', enabled: true }],
      pollIntervalMs: 50000,
    });

    const first = await runner.start();
    const second = await runner.start();

    // Second start should return existing status without calling getMe again
    expect(first).toEqual(second);
    // getMe should only be called once
    const getMeCalls = mockFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/getMe'),
    );
    expect(getMeCalls).toHaveLength(1);

    await runner.stop();
  });

  // -------------------------------------------------------------------------
  // onMessage callback is invoked for incoming updates
  // -------------------------------------------------------------------------

  it('should invoke onMessage callback for incoming Telegram updates', async () => {
    const receivedMessages: NormalizedInboundMessage[] = [];

    mockFetch
      // getMe
      .mockResolvedValueOnce(makeMockGetMeResponse())
      // First getUpdates returns a message
      .mockResolvedValueOnce(makeMockGetUpdatesResponse([{
        update_id: 1001,
        message: {
          message_id: 1,
          chat: { id: 42 },
          from: { id: 99, username: 'user1' },
          text: 'Hello bot!',
          date: Math.floor(Date.now() / 1000),
        },
      }]))
      // sendMessage response for the reply
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, result: { message_id: 2 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
      // Subsequent getUpdates returns empty (and we'll stop)
      .mockResolvedValue(makeMockGetUpdatesResponse([]));

    const runner = new GatewayRunner({
      platforms: [{ name: 'telegram', token: 'test-token', enabled: true }],
      pollIntervalMs: 10,
      onMessage: async (msg) => {
        receivedMessages.push(msg);
        return 'Reply!';
      },
    });

    await runner.start();

    // Wait for the poll loop to process the update
    await new Promise((resolve) => setTimeout(resolve, 200));

    await runner.stop();

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]!.text).toBe('Hello bot!');
    expect(receivedMessages[0]!.platform).toBe('telegram');
    expect(receivedMessages[0]!.channelId).toBe('42');
  });

  // -------------------------------------------------------------------------
  // Network error during getMe
  // -------------------------------------------------------------------------

  it('should handle network error during Telegram getMe', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network unreachable'));

    const runner = new GatewayRunner({
      platforms: [{ name: 'telegram', token: 'token', enabled: true }],
    });

    const statuses = await runner.start();
    expect(statuses[0]!.connected).toBe(false);
    expect(statuses[0]!.error).toBe('Network unreachable');

    await runner.stop();
  });
});

// ---------------------------------------------------------------------------
// CLI gateway command parsing
// ---------------------------------------------------------------------------

describe('CLI gateway command', () => {
  it('should parse "gateway status" command', () => {
    const parsed = parseCliArgs(['gateway', 'status']);
    expect(parsed.command).toBe('gateway');
    expect(parsed.gatewaySubcommand).toBe('status');
  });

  it('should parse "gateway connect telegram" command', () => {
    const parsed = parseCliArgs(['gateway', 'connect', 'telegram']);
    expect(parsed.command).toBe('gateway');
    expect(parsed.gatewaySubcommand).toBe('connect');
    expect(parsed.gatewayArgs).toEqual(['telegram']);
  });

  it('should default gateway subcommand to "status"', () => {
    const parsed = parseCliArgs(['gateway']);
    expect(parsed.command).toBe('gateway');
    expect(parsed.gatewaySubcommand).toBe('status');
  });
});
