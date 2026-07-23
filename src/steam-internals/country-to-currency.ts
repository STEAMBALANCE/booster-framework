/** Steam store-country (ISO 3166-1 alpha-2) → wallet currency (ISO 4217),
 *  scoped to the product's RU audience. Steam assigns wallet currency by
 *  store country: RU/KZ/UA have their own; the CIS-USD region is USD-priced.
 *  The single fallback rule for currency: used when the wallet balance string
 *  is empty (zero-balance wallets emit no `strAccountBalance`, so
 *  `deriveCurrency` has nothing to read). Unknown country → undefined
 *  (graceful, mirrors deriveCurrency).
 *  See also `country-map.ts` (Steam country NAME → ISO); this maps ISO →
 *  wallet currency. */
const COUNTRY_TO_CURRENCY: Record<string, string> = {
  RU: 'RUB',
  KZ: 'KZT',
  UA: 'UAH',
  // CIS-USD region — Steam stores priced in USD.
  AZ: 'USD', AM: 'USD', BY: 'USD', GE: 'USD', KG: 'USD',
  MD: 'USD', TJ: 'USD', TM: 'USD', UZ: 'USD',
};

/** Wallet currency for a Steam store country, or undefined if out of scope. */
export function currencyForStoreCountry(country: string | undefined): string | undefined {
  if (!country) return undefined;
  return COUNTRY_TO_CURRENCY[country.trim().toUpperCase()];
}
