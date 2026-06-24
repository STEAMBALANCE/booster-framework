import { test, expect, describe } from 'bun:test';
import { deriveCurrency, CURRENCY_BY_SYMBOL } from '../src/steam-internals/currency-map';

describe('deriveCurrency: known currencies (RU-aud primary)', () => {
  test('KZT from "2 177,35₸" (NBSP-separated)', () => {
    // U+00A0 between 2 and 177
    expect(deriveCurrency('2 177,35₸')).toBe('KZT');
  });
  test('RUB from "123,45₽"', () => {
    expect(deriveCurrency('123,45₽')).toBe('RUB');
  });
  test('RUB from "123,45 руб" (alt RU formatting, dot stripped)', () => {
    expect(deriveCurrency('123,45 руб')).toBe('RUB');
    expect(deriveCurrency('123,45 руб.')).toBe('RUB');  // dot also stripped
  });
  test('USD from "$1.50"', () => {
    expect(deriveCurrency('$1.50')).toBe('USD');
  });
  test('EUR from "1,50€"', () => {
    expect(deriveCurrency('1,50€')).toBe('EUR');
  });
  test('UAH from "50,00₴"', () => {
    expect(deriveCurrency('50,00₴')).toBe('UAH');
  });
});

describe('deriveCurrency: extended set', () => {
  test('GBP, JPY, KRW, TRY, INR', () => {
    expect(deriveCurrency('£10.00')).toBe('GBP');
    expect(deriveCurrency('¥150')).toBe('JPY');
    expect(deriveCurrency('₩1000')).toBe('KRW');
    expect(deriveCurrency('₺25,50')).toBe('TRY');
    expect(deriveCurrency('₹100,00')).toBe('INR');
  });
  test('BRL/ZAR collision: "R$ 1,00" → BRL, "R 1,00" → ZAR', () => {
    expect(deriveCurrency('R$ 1,00')).toBe('BRL');
    expect(deriveCurrency('R 1,00')).toBe('ZAR');
  });
  test("CHF apostrophe separator: \"CHF 1'234.56\" → CHF", () => {
    expect(deriveCurrency("CHF 1'234.56")).toBe('CHF');
  });
  test('NOK from "kr 100,00" (documented false-positive for SEK/DKK)', () => {
    expect(deriveCurrency('kr 100,00')).toBe('NOK');
  });
});

describe('deriveCurrency: separator handling', () => {
  test('thin-space (U+2009) handled', () => {
    expect(deriveCurrency('1 000,00₸')).toBe('KZT');  // U+2009 thin-space
  });
  test('NNBSP (U+202F) handled', () => {
    expect(deriveCurrency('1 000,00₽')).toBe('RUB');  // U+202F narrow-no-break-space
  });
});

describe('deriveCurrency: degenerate input', () => {
  test('empty string returns undefined', () => {
    expect(deriveCurrency('')).toBeUndefined();
  });
  test('unknown symbol returns undefined', () => {
    expect(deriveCurrency('100,00₫')).toBeUndefined();  // Vietnamese dong, not in map
  });
  test('only digits returns undefined (strip → empty)', () => {
    expect(deriveCurrency('12345')).toBeUndefined();
  });
  test('null/undefined input safely returns undefined', () => {
    // @ts-expect-error - test runtime safety
    expect(deriveCurrency(null)).toBeUndefined();
    // @ts-expect-error
    expect(deriveCurrency(undefined)).toBeUndefined();
  });
});

describe('CURRENCY_BY_SYMBOL: completeness check', () => {
  test('contains all RU-audience-relevant currencies', () => {
    for (const sym of ['₽', '₸', '₴', '$', '€']) {
      expect(CURRENCY_BY_SYMBOL[sym]).toBeDefined();
    }
  });
});

import { parseBalanceNumber } from '../src/steam-internals/currency-map';

describe('parseBalanceNumber: locale formats', () => {
  test('KZT NBSP-grouped, comma decimal: "2 177,35₸" → 2177.35', () => {
    expect(parseBalanceNumber('2 177,35₸')).toBe(2177.35);
  });
  test('RUB comma decimal: "123,45₽" → 123.45', () => {
    expect(parseBalanceNumber('123,45₽')).toBe(123.45);
  });
  test('USD dot decimal prefix: "$1.50" → 1.5', () => {
    expect(parseBalanceNumber('$1.50')).toBe(1.5);
  });
  test('EUR comma decimal suffix: "1,50€" → 1.5', () => {
    expect(parseBalanceNumber('1,50€')).toBe(1.5);
  });
  test('UAH comma decimal: "50,00₴" → 50', () => {
    expect(parseBalanceNumber('50,00₴')).toBe(50);
  });
  test('BRL dot grouping + comma decimal: "R$ 1.234,56" → 1234.56', () => {
    expect(parseBalanceNumber('R$ 1.234,56')).toBe(1234.56);
  });
  test("CHF apostrophe grouping: \"CHF 1'234.56\" → 1234.56", () => {
    expect(parseBalanceNumber("CHF 1'234.56")).toBe(1234.56);
  });
  test('KRW no decimal: "₩1000" → 1000', () => {
    expect(parseBalanceNumber('₩1000')).toBe(1000);
  });
  test('JPY no decimal: "¥150" → 150', () => {
    expect(parseBalanceNumber('¥150')).toBe(150);
  });
  test('thin-space (U+2009) grouped: "1 000,00₸" → 1000', () => {
    expect(parseBalanceNumber('1 000,00₸')).toBe(1000);
  });
  test('NNBSP (U+202F) grouped: "1 000,00₽" → 1000', () => {
    expect(parseBalanceNumber('1 000,00₽')).toBe(1000);
  });
  test('zero balance: "0,00₸" → 0', () => {
    expect(parseBalanceNumber('0,00₸')).toBe(0);
  });
  test('big number with both separators: "12 345 678,90₸" → 12345678.9', () => {
    expect(parseBalanceNumber('12 345 678,90₸')).toBe(12345678.9);
  });
  test('single fractional digit: "1,5₽" → 1.5', () => {
    expect(parseBalanceNumber('1,5₽')).toBe(1.5);
  });
});

describe('parseBalanceNumber: degenerate input', () => {
  test('empty string → undefined', () => {
    expect(parseBalanceNumber('')).toBeUndefined();
  });
  test('only currency symbol → undefined', () => {
    expect(parseBalanceNumber('₽')).toBeUndefined();
    expect(parseBalanceNumber('$')).toBeUndefined();
  });
  test('whitespace only → undefined', () => {
    expect(parseBalanceNumber('   ')).toBeUndefined();
  });
  test('null/undefined safely → undefined', () => {
    // @ts-expect-error - test runtime safety
    expect(parseBalanceNumber(null)).toBeUndefined();
    // @ts-expect-error
    expect(parseBalanceNumber(undefined)).toBeUndefined();
  });
});
