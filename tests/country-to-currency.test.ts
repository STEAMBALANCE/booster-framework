import { describe, expect, test } from 'bun:test';
import { currencyForStoreCountry } from '../src/steam-internals/country-to-currency';

describe('currencyForStoreCountry', () => {
  test('own-currency countries', () => {
    expect(currencyForStoreCountry('RU')).toBe('RUB');
    expect(currencyForStoreCountry('KZ')).toBe('KZT');
    expect(currencyForStoreCountry('UA')).toBe('UAH');
  });
  test('CIS-USD region maps to USD', () => {
    for (const c of ['AZ', 'AM', 'BY', 'GE', 'KG', 'MD', 'TJ', 'TM', 'UZ']) {
      expect(currencyForStoreCountry(c)).toBe('USD');
    }
  });
  test('case-insensitive + trims', () => {
    expect(currencyForStoreCountry('by')).toBe('USD');
    expect(currencyForStoreCountry(' RU ')).toBe('RUB');
  });
  test('unknown / empty → undefined', () => {
    expect(currencyForStoreCountry('US')).toBeUndefined();
    expect(currencyForStoreCountry('')).toBeUndefined();
    expect(currencyForStoreCountry(undefined)).toBeUndefined();
  });
});
