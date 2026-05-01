import { describe, it, expect } from 'bun:test';
import { checkUrlSafe } from '../lib/ssrf';

describe('checkUrlSafe', () => {
  describe('allows', () => {
    it('public https URLs', () => {
      expect(checkUrlSafe('https://example.com/').ok).toBe(true);
      expect(checkUrlSafe('https://api.openai.com/v1/chat').ok).toBe(true);
    });

    it('public http URLs (we leave TLS to the app)', () => {
      expect(checkUrlSafe('http://example.com/').ok).toBe(true);
    });

    it('URLs with paths/queries', () => {
      expect(checkUrlSafe('https://hooks.zapier.com/abc/def?x=1').ok).toBe(true);
    });
  });

  describe('blocks invalid input', () => {
    it('non-URL strings', () => {
      expect(checkUrlSafe('not a url').ok).toBe(false);
      expect(checkUrlSafe('').ok).toBe(false);
    });

    it('non-http(s) schemes', () => {
      expect(checkUrlSafe('file:///etc/passwd').ok).toBe(false);
      expect(checkUrlSafe('ftp://example.com/').ok).toBe(false);
      expect(checkUrlSafe('javascript:alert(1)').ok).toBe(false);
      expect(checkUrlSafe('gopher://1.2.3.4/').ok).toBe(false);
    });
  });

  describe('blocks RFC1918 + reserved IPv4', () => {
    it('10.0.0.0/8', () => {
      expect(checkUrlSafe('http://10.0.0.1/').ok).toBe(false);
      expect(checkUrlSafe('http://10.255.255.255/').ok).toBe(false);
    });

    it('127.0.0.0/8 loopback', () => {
      expect(checkUrlSafe('http://127.0.0.1/').ok).toBe(false);
      expect(checkUrlSafe('http://127.1.2.3/').ok).toBe(false);
    });

    it('172.16.0.0/12', () => {
      expect(checkUrlSafe('http://172.16.0.1/').ok).toBe(false);
      expect(checkUrlSafe('http://172.31.255.255/').ok).toBe(false);
      // 172.15 and 172.32 should be public
      expect(checkUrlSafe('http://172.15.0.1/').ok).toBe(true);
      expect(checkUrlSafe('http://172.32.0.1/').ok).toBe(true);
    });

    it('192.168.0.0/16', () => {
      expect(checkUrlSafe('http://192.168.1.1/').ok).toBe(false);
    });

    it('169.254.0.0/16 (link-local incl. cloud IMDS)', () => {
      expect(checkUrlSafe('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
    });

    it('100.64.0.0/10 CGNAT', () => {
      expect(checkUrlSafe('http://100.64.0.1/').ok).toBe(false);
      expect(checkUrlSafe('http://100.127.255.255/').ok).toBe(false);
      // 100.63 and 100.128 are public
      expect(checkUrlSafe('http://100.63.0.1/').ok).toBe(true);
      expect(checkUrlSafe('http://100.128.0.1/').ok).toBe(true);
    });

    it('multicast 224/4 + reserved 240/4', () => {
      expect(checkUrlSafe('http://224.0.0.1/').ok).toBe(false);
      expect(checkUrlSafe('http://240.0.0.1/').ok).toBe(false);
    });
  });

  describe('blocks IPv6 internals', () => {
    it('::1 loopback', () => {
      expect(checkUrlSafe('http://[::1]/').ok).toBe(false);
    });

    it('fe80::/10 link-local', () => {
      expect(checkUrlSafe('http://[fe80::1]/').ok).toBe(false);
    });

    it('fc00::/7 unique local', () => {
      expect(checkUrlSafe('http://[fc00::1]/').ok).toBe(false);
      expect(checkUrlSafe('http://[fd00::1]/').ok).toBe(false);
    });
  });

  describe('blocks internal hostnames', () => {
    it('localhost', () => {
      expect(checkUrlSafe('http://localhost/').ok).toBe(false);
      expect(checkUrlSafe('http://localhost:5432/').ok).toBe(false);
    });

    it('*.local / *.internal / *.localhost', () => {
      expect(checkUrlSafe('http://api.local/').ok).toBe(false);
      expect(checkUrlSafe('http://service.internal/').ok).toBe(false);
      expect(checkUrlSafe('http://x.localhost/').ok).toBe(false);
    });

    it('cloud metadata explicit hostnames', () => {
      expect(checkUrlSafe('http://metadata.google.internal/').ok).toBe(false);
      expect(checkUrlSafe('http://metadata.aws.internal/').ok).toBe(false);
    });
  });

  it('returns a reason string on rejection', () => {
    const r = checkUrlSafe('http://10.0.0.1/');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('private');
    }
  });
});
