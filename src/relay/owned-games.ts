import type { GetOwnedGamesRequest } from './protocol';
import type { RelayPoster } from './channel';
import type { OwnedGame, OwnedGamesResult, GamePrice } from '../api/api-types';
import { readOwnedGames } from '../steam-internals/owned-games';
import { loadLibraryPrices } from '../steam-internals/library-prices';
import { deriveCurrency } from '../steam-internals/currency-map';

export async function handleGetOwnedGames(msg: GetOwnedGamesRequest, bc: RelayPoster): Promise<void> {
  let result: OwnedGamesResult;
  try {
    const { games, ready, familySharedExcluded } = await readOwnedGames();
    if (!msg.includePrices) {
      result = { games, pricesIncluded: false, ready, familySharedExcluded };
    } else {
      const prices = await loadLibraryPrices(games.map((g) => g.appid));
      let currency: string | undefined;
      const withPrice: OwnedGame[] = games.map((g) => {
        const price: GamePrice | undefined = prices.get(g.appid);
        if (!currency && price?.formattedFinal) currency = deriveCurrency(price.formattedFinal);
        return { ...g, price };
      });
      result = { games: withPrice, pricesIncluded: true, currency, ready, familySharedExcluded };
    }
  } catch {
    result = { games: [], pricesIncluded: !!msg.includePrices, ready: false, familySharedExcluded: 0 };
  }
  bc.postMessage({ kind: 'owned-games-ok', requestId: msg.requestId, result });
}
