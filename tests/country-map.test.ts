import { test, expect } from 'bun:test';
import { storeCountryNameToIso } from '../src/steam-internals/country-map';

test('maps confirmed Steam English names to ISO alpha-2', () => {
  expect(storeCountryNameToIso('Kazakhstan')).toBe('KZ');
  expect(storeCountryNameToIso('Ukraine')).toBe('UA');
  expect(storeCountryNameToIso('Belarus')).toBe('BY');
  expect(storeCountryNameToIso('Germany')).toBe('DE');
  expect(storeCountryNameToIso('United States')).toBe('US');
});

test('handles Russia name variants', () => {
  expect(storeCountryNameToIso('Russia')).toBe('RU');
  expect(storeCountryNameToIso('Russian Federation')).toBe('RU');
});

test('is whitespace- and case-insensitive', () => {
  expect(storeCountryNameToIso('  kazakhstan  ')).toBe('KZ');
  expect(storeCountryNameToIso('UKRAINE')).toBe('UA');
});

test('returns undefined for unknown / empty', () => {
  expect(storeCountryNameToIso('Atlantis')).toBeUndefined();
  expect(storeCountryNameToIso('')).toBeUndefined();
});
