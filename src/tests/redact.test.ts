import { describe, it, expect } from 'bun:test';
import { redactPhone, redactEmail } from '../lib/logger';

describe('redactPhone', () => {
  it('keeps the first 4 and last 4 digits', () => {
    expect(redactPhone('5511995432538')).toBe('5511***2538');
  });

  it('strips non-digit characters before redacting', () => {
    expect(redactPhone('+55 (11) 99543-2538')).toBe('5511***2538');
  });

  it('returns *** for very short inputs', () => {
    expect(redactPhone('123')).toBe('***');
    expect(redactPhone('1')).toBe('***');
  });

  it('returns empty for nullish inputs', () => {
    expect(redactPhone(null)).toBe('');
    expect(redactPhone(undefined)).toBe('');
    expect(redactPhone('')).toBe('');
  });
});

describe('redactEmail', () => {
  it('keeps first letter of local part and full domain', () => {
    expect(redactEmail('kaolin@gmail.com')).toBe('k*****@gmail.com');
  });

  it('handles short local parts', () => {
    expect(redactEmail('a@b.com')).toBe('a**@b.com');
  });

  it('returns *** when no @ present', () => {
    expect(redactEmail('not-an-email')).toBe('***');
  });

  it('returns empty for nullish inputs', () => {
    expect(redactEmail(null)).toBe('');
    expect(redactEmail(undefined)).toBe('');
    expect(redactEmail('')).toBe('');
  });
});
