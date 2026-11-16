import { describe, expect, it } from 'vitest';
import { readConsent, recordsEnabled } from './consent';

describe('readConsent', () => {
  it('reads the stored choice from the cookie string', () => {
    expect(readConsent('a=1; iris_consent=all; b=2')).toBe('all');
    expect(readConsent('iris_consent=necessary')).toBe('necessary');
    expect(readConsent('iris_consent=none')).toBe('none');
  });

  it('treats a missing or unknown choice as no choice yet', () => {
    expect(readConsent('')).toBeNull();
    expect(readConsent('iris_consent=maybe')).toBeNull();
    expect(readConsent('other_iris_consent=all')).toBeNull();
  });
});

describe('recordsEnabled', () => {
  it('saves records with the necessary cookies or all of them, never without', () => {
    expect(recordsEnabled('necessary')).toBe(true);
    expect(recordsEnabled('all')).toBe(true);
    expect(recordsEnabled('none')).toBe(false);
    expect(recordsEnabled(null)).toBe(false);
  });
});
