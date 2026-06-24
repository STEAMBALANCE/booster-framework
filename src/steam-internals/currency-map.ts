// strings-allow-cyrillic: file — keys mirror Steam's localized balance prefixes byte-for-byte; not translatable UI copy.
/** ISO 4217 code by Steam wallet currency symbol or short prefix.
 *  Keys are the exact strings remaining after `deriveCurrency` strips
 *  digits, separators (`,` `.` `'` ASCII-space NBSP thin-space NNBSP)
 *  from a localized Steam balance string.
 *
 *  Source: Steam economy formatting per `RegisterForCurrentUserChanges`
 *  → `strAccountBalance` field across Steam's supported currencies.
 *  Captured from Steam's `economy.cpp` wallet display routine + spot-
 *  checks against live accounts.
 *
 *  When Steam adds a new country, the symbol here may need a new entry.
 *  `deriveCurrency()` returns undefined for unknown symbols (popup
 *  default RUB selection — graceful degradation). */
export const CURRENCY_BY_SYMBOL: Record<string, string> = {
  '₽':    'RUB',
  'руб':  'RUB',
  '₸':    'KZT',
  '₴':    'UAH',
  '$':    'USD',  // ambiguous (CAD/AUD/NZD/SGD); USD is best-effort default
  '€':    'EUR',
  '£':    'GBP',
  '¥':    'JPY',
  '₩':    'KRW',
  '₺':    'TRY',
  '₹':    'INR',
  'R$':   'BRL',
  'CLP$': 'CLP',
  'COL$': 'COP',
  'Mex$': 'MXN',
  'ARS$': 'ARS',
  'S/.':  'PEN',
  'NT$':  'TWD',
  'HK$':  'HKD',
  '฿':    'THB',
  'Rp':   'IDR',
  'RM':   'MYR',
  '₱':    'PHP',
  'CHF':  'CHF',
  'kr':   'NOK',  // also SEK/DKK; conflict accepted (out-of-RU-scope)
  'zł':   'PLN',
  'Kč':   'CZK',
  'Ft':   'HUF',
  'lei':  'RON',
  'ман':  'AZN',
  '₪':    'ILS',
  'SAR':  'SAR',
  'AED':  'AED',
  'R':    'ZAR',  // single-letter; BRL "R$" matched first (full-string lookup)
};

/** Steam balance separators stripped before symbol lookup.
 *  Explicit Unicode escapes for non-ASCII whitespace so the literal
 *  codepoints aren't lost in editors that render NBSP / thin-space /
 *  NNBSP identically to ASCII space.
 *    \d       digits
 *    , .      decimal/thousands separators
 *    '        apostrophe (CHF "1'234.56" thousands marker)
 *    <space>  ASCII space (U+0020)
 *        NBSP (Russian/Ukrainian/Kazakh format)
 *        thin-space
 *        narrow-no-break-space (some EU locales) */
const SEPARATORS_RE = /[\d,. '\u00A0\u2009\u202F]/g;

/** Extract ISO 4217 code from a localized Steam wallet balance string.
 *  Returns undefined for empty input, unknown symbols, or strings that
 *  match no map entry after stripping. */
export function deriveCurrency(formattedBalance: string): string | undefined {
  if (!formattedBalance) return undefined;
  const stripped = formattedBalance.replace(SEPARATORS_RE, '');
  return CURRENCY_BY_SYMBOL[stripped];
}

/** Parse a localized Steam wallet balance string into a numeric value.
 *  Handles all the locale formats Steam emits:
 *    "2 177,35₸"   → 2177.35   (KZ — NBSP grouping, comma decimal)
 *    "123,45₽"     → 123.45    (RU — comma decimal)
 *    "$1.50"       → 1.50      (US — dot decimal)
 *    "1,50€"       → 1.50      (EU — comma decimal)
 *    "R$ 1.234,56" → 1234.56   (BR — dot grouping, comma decimal)
 *    "CHF 1'234.56"→ 1234.56   (CH — apostrophe grouping)
 *    "₩1000"       → 1000      (KR — no decimal)
 *  Returns undefined for empty / unparseable input.
 *
 *  Algorithm: strip non-digit/non-separator chars (currency symbols,
 *  whitespace), then look for the rightmost `,` or `.` followed by 1-2
 *  digits at end-of-string — that's the decimal separator. Everything
 *  before is the integer part with grouping separators stripped.
 *  Strings with no trailing decimal pattern (e.g. JPY, KRW) are
 *  parsed as pure integers. */
export function parseBalanceNumber(formattedBalance: string): number | undefined {
  if (!formattedBalance) return undefined;
  // Keep only digits and the separators we care about; drop currency
  // symbols and every kind of whitespace.
  const cleaned = formattedBalance.replace(/[^\d,.']/g, '');
  if (!cleaned) return undefined;
  // Detect decimal: rightmost `,` or `.` with 1-2 digits after, anchored
  // at end-of-string. The integer chunk before it can contain grouping
  // separators (`,` `.` `'`) which we strip.
  const m = cleaned.match(/^([\d,.']*?)([,.])(\d{1,2})$/);
  if (m) {
    const integerStr = m[1]!.replace(/[^\d]/g, '') || '0';
    const fracStr = m[3]!.padEnd(2, '0').slice(0, 2);
    const n = Number(integerStr + '.' + fracStr);
    return Number.isFinite(n) ? n : undefined;
  }
  // No decimal portion — pure integer (KRW/JPY/COP-style).
  const intStr = cleaned.replace(/[^\d]/g, '');
  if (!intStr) return undefined;
  const n = Number(intStr);
  return Number.isFinite(n) ? n : undefined;
}
