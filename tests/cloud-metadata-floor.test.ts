// v0.9.0 (#298) — cloud-metadata SSRF floor. Hermes v0.13 #21228 closed the
// browser hybrid-routing bypass by centralizing the SSRF preflight; we ship
// the same floor for *every* outbound HTTP tool (fetch, vision, image —
// browser is forward-compat — under one `assertSafeUrl(url, { kind })` helper).
//
// Acceptance criteria (paraphrased from the issue):
//   1. Cloud-metadata hostnames return SsrfDenied for *every* kind.
//   2. IPv6 link-local / cloud-metadata addresses blocked.
//   3. DNS-aware: hostname that resolves to 169.254.169.254 is denied after
//      lookup even though the regex would have let it through.
//   4. Audit envelope carries host, resolvedIp, kind, code.
//
// Each numbered assertion below maps to an acceptance criterion so a future
// re-audit can grep `// AC` to spot regressions.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CLOUD_METADATA_HOSTS,
  assertSafeUrl,
  ssrfDenialMessage,
  ssrfAuditDetail,
  ToolRegistry,
  createWebFetchTool,
  createVisionAnalyzeTool,
} from '@crowclaw/tools';

describe('cloud-metadata SSRF floor (#298)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // AC1: every hostname in the curated list is blocked regardless of kind.
  describe('AC1: cloud-metadata hostnames blocked across kinds', () => {
    const kinds = ['fetch', 'browser', 'vision', 'image'] as const;
    const hostnames = [
      'metadata.google.internal',
      'metadata.azure.com',
      '169.254.169.254',
      '100.100.100.200',
      '192.0.0.192',
    ];

    for (const host of hostnames) {
      for (const kind of kinds) {
        it(`blocks ${host} for kind=${kind}`, async () => {
          // dnsLookup=null forces regex-only mode so the host string itself
          // has to trigger the denial (no DNS-rebinding cover).
          const result = await assertSafeUrl(`http://${host}/secrets`, {
            kind,
            dnsLookup: null,
          });
          expect(result.safe).toBe(false);
          if (result.safe === false) {
            // Every member of CLOUD_METADATA_HOSTS reports the dedicated
            // SSRF_CLOUD_METADATA code, including the literal IPs (which
            // would *also* match the private-network regex). The dedicated
            // code wins because triage cares about the attack discriminator.
            expect(result.code).toBe('SSRF_CLOUD_METADATA');
            expect(result.kind).toBe(kind);
            expect(result.host).toBe(host.toLowerCase());
          }
        });
      }
    }
  });

  // AC2: IPv6 cloud-metadata and link-local addresses can't sneak through.
  describe('AC2: IPv6 cloud-metadata literals blocked', () => {
    it('blocks fd00:ec2::254 (AWS IMDSv2 IPv6)', async () => {
      const result = await assertSafeUrl('http://[fd00:ec2::254]/latest/meta-data/', {
        kind: 'fetch',
        dnsLookup: null,
      });
      expect(result.safe).toBe(false);
      if (result.safe === false) {
        // The IPv6 literal matches the cloud-metadata host set directly.
        expect(['SSRF_CLOUD_METADATA', 'SSRF_PRIVATE_NETWORK']).toContain(result.code);
      }
    });

    it('blocks fe80::1 (IPv6 link-local) via the private-network floor', async () => {
      const result = await assertSafeUrl('http://[fe80::1]/admin', {
        kind: 'fetch',
        dnsLookup: null,
      });
      expect(result.safe).toBe(false);
    });
  });

  // AC3: DNS-aware — a public-looking hostname pointing to 169.254.169.254
  // must still be denied. This is the bypass Hermes #21228 actually closed.
  describe('AC3: DNS-rebinding cover (resolves to metadata IP)', () => {
    it('denies attacker.example.com that resolves to 169.254.169.254', async () => {
      const stubLookup = vi.fn(async (host: string) => {
        if (host === 'attacker.example.com') return ['169.254.169.254'];
        return ['8.8.8.8'];
      });

      const result = await assertSafeUrl('https://attacker.example.com/path', {
        kind: 'browser',
        dnsLookup: stubLookup,
      });

      expect(result.safe).toBe(false);
      if (result.safe === false) {
        // The resolver fired *and* the resolved IP matches the metadata set,
        // so we expect the dedicated CLOUD_METADATA code, not the generic
        // PRIVATE_NETWORK fallback. Forensics relies on this discriminator.
        expect(result.code).toBe('SSRF_CLOUD_METADATA');
        expect(result.resolvedIp).toBe('169.254.169.254');
        expect(result.host).toBe('attacker.example.com');
      }
      expect(stubLookup).toHaveBeenCalledWith('attacker.example.com');
    });

    it('denies attacker.example.com that resolves to a generic RFC1918 IP', async () => {
      const stubLookup = vi.fn(async () => ['10.0.0.5']);
      const result = await assertSafeUrl('https://attacker.example.com/', {
        kind: 'fetch',
        dnsLookup: stubLookup,
      });
      expect(result.safe).toBe(false);
      if (result.safe === false) {
        expect(result.code).toBe('SSRF_PRIVATE_NETWORK');
        expect(result.resolvedIp).toBe('10.0.0.5');
      }
    });

    it('allows a regular public host', async () => {
      const stubLookup = vi.fn(async () => ['151.101.1.69']);
      const result = await assertSafeUrl('https://example.com/', {
        kind: 'fetch',
        dnsLookup: stubLookup,
      });
      expect(result.safe).toBe(true);
      if (result.safe) {
        expect(result.host).toBe('example.com');
        expect(result.resolvedIps).toEqual(['151.101.1.69']);
        expect(result.kind).toBe('fetch');
      }
    });
  });

  // AC4: audit-log envelope contains the fields dashboards parse.
  describe('AC4: audit envelope shape', () => {
    it('ssrfAuditDetail includes kind, code, host, resolvedIp, reason', async () => {
      const stubLookup = vi.fn(async () => ['169.254.169.254']);
      const result = await assertSafeUrl('https://attacker.example.com/', {
        kind: 'vision',
        dnsLookup: stubLookup,
      });

      expect(result.safe).toBe(false);
      if (result.safe === false) {
        const detail = ssrfAuditDetail(result);
        expect(detail).toContain('kind=vision');
        expect(detail).toContain('code=SSRF_CLOUD_METADATA');
        expect(detail).toContain('host=attacker.example.com');
        expect(detail).toContain('resolvedIp=169.254.169.254');
        expect(detail).toContain('reason=');
      }
    });

    it('ssrfDenialMessage returns the legacy "URL blocked: ..." string', async () => {
      const result = await assertSafeUrl('http://metadata.google.internal/', {
        kind: 'fetch',
        dnsLookup: null,
      });
      expect(result.safe).toBe(false);
      if (result.safe === false) {
        const msg = ssrfDenialMessage(result);
        expect(msg).toMatch(/^URL blocked: /);
        expect(msg).toContain('metadata.google.internal');
      }
    });
  });

  // Wiring: confirm web.fetch and vision.analyze surface the floor through
  // their tool envelopes. The existing web-tool-ssrf-wiring.test.ts covers
  // the regex-only RFC1918 case — this adds the hostname-spelled metadata
  // case, which is the actual #298 gap.
  describe('tool-surface wiring: cloud-metadata reaches the envelope', () => {
    it('web.fetch returns URL blocked for metadata.google.internal', async () => {
      const fetchMock = vi.fn(async () => new Response('SHOULD NOT BE CALLED'));
      vi.stubGlobal('fetch', fetchMock);

      const registry = new ToolRegistry().register(createWebFetchTool());
      const result = await registry.execute(
        'web.fetch',
        { url: 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' },
        { agentId: 'crowclaw', sessionId: 'cloud-md-test' },
      );

      expect(result.ok).toBe(false);
      expect(result.output).toContain('URL blocked');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('vision.analyze blocks metadata.google.internal source URL', async () => {
      const fetchMock = vi.fn(async () => new Response('SHOULD NOT BE CALLED'));
      vi.stubGlobal('fetch', fetchMock);

      const tool = createVisionAnalyzeTool({ apiKey: 'fake-key' });
      const result = await tool.execute(
        { url: 'http://metadata.google.internal/computeMetadata/v1/instance/' },
        { agentId: 'crowclaw', sessionId: 'cloud-md-vision' },
      );

      expect(result.ok).toBe(false);
      expect(result.output).toContain('URL blocked');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // Sanity: the curated list isn't empty (regression guard if someone edits
  // ssrf-blocklist.ts and clobbers the set by mistake).
  it('CLOUD_METADATA_HOSTS covers the canonical providers', () => {
    expect(CLOUD_METADATA_HOSTS.has('169.254.169.254')).toBe(true);
    expect(CLOUD_METADATA_HOSTS.has('metadata.google.internal')).toBe(true);
    expect(CLOUD_METADATA_HOSTS.has('metadata.azure.com')).toBe(true);
    expect(CLOUD_METADATA_HOSTS.has('100.100.100.200')).toBe(true); // Alibaba
    expect(CLOUD_METADATA_HOSTS.has('192.0.0.192')).toBe(true); // Oracle
    expect(CLOUD_METADATA_HOSTS.has('fd00:ec2::254')).toBe(true); // AWS IPv6
  });
});
