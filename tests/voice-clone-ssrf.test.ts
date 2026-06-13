// v0.9.1 (#298 migration) — voice.clone sample-URL preflight now routes
// through the canonical `assertSafeUrl({ kind: 'image' })` helper instead of a
// local stopgap, so a cloud-metadata sample URL is rejected with the central
// SSRF forensic code (SSRF_CLOUD_METADATA) and the media `image` kind for
// audit routing.
//
// Acceptance:
//   1. A cloud-metadata sample URL is rejected with code SSRF_CLOUD_METADATA.
//   2. The denial reports kind=image (the migrated discriminator).
//   3. The upstream fetch / provider is never invoked on a blocked URL.
//   4. A private-network sample URL is also rejected (SSRF_PRIVATE_NETWORK).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createVoiceCloneTool, type VoiceCloneProvider } from '@crowclaw/tools';

const ctx = { agentId: 'crowclaw', sessionId: 'voice-clone-ssrf' };

function stubProvider(): { provider: VoiceCloneProvider; clone: ReturnType<typeof vi.fn> } {
  const clone = vi.fn(async () => ({ voiceId: 'voice_test' }));
  return {
    clone,
    provider: { name: 'xai', cloneVoice: clone },
  };
}

describe('voice.clone SSRF preflight (#298 migration)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a cloud-metadata sample URL with the central SSRF_CLOUD_METADATA code', async () => {
    const fetchMock = vi.fn(async () => new Response('SHOULD NOT BE CALLED'));
    vi.stubGlobal('fetch', fetchMock);
    const { provider, clone } = stubProvider();

    const tool = createVoiceCloneTool({ providers: { xai: provider }, defaultProvider: 'xai' });
    const result = await tool.execute(
      {
        name: 'evil-clone',
        // GCP metadata DNS form — caught by hostname match before any DNS
        // resolution, so this is deterministic without stubbing node:dns.
        sampleUrl: 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      },
      ctx,
    );

    // AC1 + AC2 — blocked, central forensic code, migrated `image` kind.
    expect(result.ok).toBe(false);
    expect(result.output).toContain('URL blocked');
    expect(result.metadata?.ssrfCode).toBe('SSRF_CLOUD_METADATA');
    expect(result.metadata?.ssrfDeniedKind).toBe('image');

    // AC3 — neither the sample fetch nor the provider upload ran.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it('rejects the AWS IMDS IP literal sample URL', async () => {
    const fetchMock = vi.fn(async () => new Response('SHOULD NOT BE CALLED'));
    vi.stubGlobal('fetch', fetchMock);
    const { provider } = stubProvider();

    const tool = createVoiceCloneTool({ providers: { xai: provider }, defaultProvider: 'xai' });
    const result = await tool.execute(
      { name: 'imds', sampleUrl: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.metadata?.ssrfCode).toBe('SSRF_CLOUD_METADATA');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a private-network (RFC1918) sample URL', async () => {
    const fetchMock = vi.fn(async () => new Response('SHOULD NOT BE CALLED'));
    vi.stubGlobal('fetch', fetchMock);
    const { provider } = stubProvider();

    const tool = createVoiceCloneTool({ providers: { xai: provider }, defaultProvider: 'xai' });
    const result = await tool.execute(
      { name: 'lan', sampleUrl: 'http://10.0.0.5/sample.mp3' },
      ctx,
    );

    expect(result.ok).toBe(false);
    // The IP literal is caught by the private-network regex inside assertSafeUrl.
    expect(result.metadata?.ssrfCode).toBe('SSRF_PRIVATE_NETWORK');
    expect(result.metadata?.ssrfDeniedKind).toBe('image');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
