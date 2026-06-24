/** Steam store-country English name (as rendered on /account/?l=english) →
 *  ISO 3166-1 alpha-2. Scoped to Steam's supported store countries, with the
 *  RU-adjacent set prioritized. Name variants Steam may emit are aliased to
 *  the same code. Unknown name → undefined (graceful, mirrors deriveCurrency).
 *
 *  Keys are lowercased; lookup lowercases the input. Verify the exact Steam
 *  strings against captured /account/ fixtures (plan Task 10) before relying
 *  on a code in production logic. */
const NAME_TO_ISO: Record<string, string> = {
  // CIS / RU-adjacent (primary audience)
  'russia': 'RU', 'russian federation': 'RU',
  'kazakhstan': 'KZ',
  'ukraine': 'UA',
  'belarus': 'BY',
  'armenia': 'AM',
  'azerbaijan': 'AZ',
  'georgia': 'GE',
  'kyrgyzstan': 'KG',
  'tajikistan': 'TJ',
  'turkmenistan': 'TM',
  'uzbekistan': 'UZ',
  'moldova': 'MD', 'republic of moldova': 'MD',
  // Europe
  'germany': 'DE', 'france': 'FR', 'united kingdom': 'GB', 'spain': 'ES',
  'italy': 'IT', 'poland': 'PL', 'netherlands': 'NL', 'sweden': 'SE',
  'norway': 'NO', 'finland': 'FI', 'denmark': 'DK', 'czechia': 'CZ',
  'czech republic': 'CZ', 'austria': 'AT', 'switzerland': 'CH',
  'portugal': 'PT', 'ireland': 'IE', 'belgium': 'BE', 'greece': 'GR',
  'hungary': 'HU', 'romania': 'RO', 'bulgaria': 'BG', 'croatia': 'HR',
  'slovakia': 'SK', 'slovenia': 'SI', 'lithuania': 'LT', 'latvia': 'LV',
  'estonia': 'EE', 'serbia': 'RS', 'türkiye': 'TR', 'turkey': 'TR',
  // Americas
  'united states': 'US', 'canada': 'CA', 'brazil': 'BR', 'mexico': 'MX',
  'argentina': 'AR', 'chile': 'CL', 'colombia': 'CO', 'peru': 'PE',
  // Asia / Pacific / ME
  'china': 'CN', 'japan': 'JP', 'south korea': 'KR',
  'republic of korea': 'KR', 'india': 'IN', 'indonesia': 'ID',
  'thailand': 'TH', 'vietnam': 'VN', 'viet nam': 'VN', 'malaysia': 'MY',
  'philippines': 'PH', 'singapore': 'SG', 'australia': 'AU',
  'new zealand': 'NZ', 'israel': 'IL', 'saudi arabia': 'SA',
  'united arab emirates': 'AE', 'south africa': 'ZA',
};

/** Map a Steam English country name to ISO alpha-2. Trim + case-insensitive.
 *  Returns undefined for empty/unknown. */
export function storeCountryNameToIso(name: string): string | undefined {
  if (!name) return undefined;
  return NAME_TO_ISO[name.trim().toLowerCase()];
}
