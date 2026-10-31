import { describe, expect, it } from 'vitest';
import table from '../../../../../proto/testdata/phone_numbers.json';
import { cleanPastedNumber, dialChars, dialKey, normalizeContactNumber, normalizeNumber, splitExtension } from './phoneNumber';

interface Vector {
  in: string;
  callerId: string;
  number: string;
  contact: string;
}

// The same table the Go test (internal/sip/phone_vectors_test.go) runs.
const vectors: Vector[] = table.cases;

describe('phone number normalisation (proto/testdata/phone_numbers.json)', () => {
  it('has the vectors', () => {
    expect(vectors.length).toBeGreaterThan(10);
  });
  for (const v of vectors) {
    it(`«${v.in}» (caller ${v.callerId || '—'})`, () => {
      expect(normalizeNumber(v.in)).toBe(v.number);
      expect(normalizeContactNumber(v.in, v.callerId)).toBe(v.contact);
    });
  }
});

describe('an extension after the number (proto/testdata/phone_numbers.json «extensions»)', () => {
  const ext: Array<{ in: string; number: string; ext: string }> = table.extensions;
  it('has the vectors', () => {
    expect(ext.length).toBeGreaterThan(10);
  });
  for (const v of ext) {
    it(`«${v.in}»`, () => {
      const s = splitExtension(v.in);
      const number = s ? normalizeNumber(s.number) : '';
      expect(number ? { number, ext: s?.ext ?? '' } : { number: '', ext: '' }).toEqual({ number: v.number, ext: v.ext });
    });
  }
});

describe('the dial pad input', () => {
  it('cleans a pasted text down to the number', () => {
    expect(cleanPastedNumber('Тел.: 8 (916) 123-45-67, доб. 12')).toBe('89161234567');
    expect(cleanPastedNumber('+7 916 123-45-67')).toBe('+79161234567');
    expect(cleanPastedNumber('звоните +49 30 1234567 до 18:00')).toBe('+49301234567');
    expect(cleanPastedNumber('\u00a0+7\u00a0916\u00a0123\u00a045\u00a067')).toBe('+79161234567');
    expect(cleanPastedNumber('101')).toBe('101');
    expect(cleanPastedNumber('нет номера')).toBe('');
  });
  it('keeps «+», digits, * and #', () => {
    expect(dialChars('+7 (916) 1*2#')).toBe('+79161*2#');
    expect(dialChars('12a3')).toBe('123');
  });
  it('compares 8… and +7… as one number', () => {
    expect(dialKey('8 916 123')).toBe('7916123');
    expect(dialKey('+7 916 123')).toBe('7916123');
    expect(dialKey('0049 30')).toBe('4930');
    expect(dialKey('101')).toBe('101');
  });
});
