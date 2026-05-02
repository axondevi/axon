import { describe, it, expect } from 'bun:test';
import {
  base32Encode,
  base32Decode,
  generateSecret,
  generateCode,
  verifyCode,
  otpauthUri,
  generateRecoveryCodes,
} from '../lib/totp';

describe('base32 round-trip (RFC 4648)', () => {
  it('encode → decode is identity', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const enc = base32Encode(buf);
    const dec = base32Decode(enc);
    expect(dec.equals(buf)).toBe(true);
  });

  it('handles odd byte counts', () => {
    const buf = Buffer.from([0xff, 0x00, 0xab]);
    const dec = base32Decode(base32Encode(buf));
    expect(dec.equals(buf)).toBe(true);
  });

  it('uppercases and strips spaces', () => {
    const enc = 'jbsw y3dp ehpk 3pxp';
    const lower = base32Decode(enc);
    const upper = base32Decode('JBSWY3DPEHPK3PXP');
    expect(lower.equals(upper)).toBe(true);
  });
});

describe('TOTP code generation matches RFC 6238 test vector', () => {
  // RFC 6238 Appendix B: secret = "12345678901234567890" (ASCII).
  // Values from the SHA1 column of Table 2.
  const SECRET = Buffer.from('12345678901234567890');

  const cases: Array<[number, string]> = [
    [59, '94287082'.slice(-6)],
    [1111111109, '07081804'.slice(-6)],
    [1111111111, '14050471'.slice(-6)],
    [1234567890, '89005924'.slice(-6)],
    [2000000000, '69279037'.slice(-6)],
  ];

  for (const [t, expected] of cases) {
    it(`t=${t} → ${expected}`, () => {
      expect(generateCode(SECRET, t)).toBe(expected);
    });
  }
});

describe('verifyCode', () => {
  it('accepts the current code', () => {
    const secret = generateSecret();
    const code = generateCode(secret);
    expect(verifyCode(secret, code).ok).toBe(true);
  });

  it('rejects a code computed with a different secret', () => {
    const a = generateSecret();
    const b = generateSecret();
    const code = generateCode(a);
    expect(verifyCode(b, code).ok).toBe(false);
  });

  it('rejects malformed codes (non-digits, wrong length)', () => {
    const secret = generateSecret();
    expect(verifyCode(secret, '12345').ok).toBe(false);
    expect(verifyCode(secret, '1234567').ok).toBe(false);
    expect(verifyCode(secret, '12345a').ok).toBe(false);
    expect(verifyCode(secret, '').ok).toBe(false);
  });

  it('accepts +/- 1 step (clock skew tolerance)', () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    const prev = generateCode(secret, now - 30);
    expect(verifyCode(secret, prev, { atSec: now }).ok).toBe(true);
  });

  it('rejects replay of the same counter step', () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    const code = generateCode(secret, now);
    const r1 = verifyCode(secret, code, { atSec: now });
    expect(r1.ok).toBe(true);
    const r2 = verifyCode(secret, code, { atSec: now, lastCounter: r1.counter ?? null });
    expect(r2.ok).toBe(false);
  });
});

describe('otpauth URI shape', () => {
  it('has all required params', () => {
    const secret = generateSecret();
    const uri = otpauthUri(secret, 'kaolin@example.com', 'Axon');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=Axon');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('secret=');
  });
});

describe('recovery codes', () => {
  it('generates the requested number of unique codes', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes.length).toBe(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('codes are formatted XXXX-XXXX-XXXX', () => {
    const codes = generateRecoveryCodes(3);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
  });
});
