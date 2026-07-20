import { test, expect } from 'bun:test';
import { readOwnedGames } from '../src/steam-internals/owned-games';

function fakeCollection(apps: unknown[]) {
  (globalThis as any).window = { collectionStore: { allGamesCollection: { allApps: apps } } };
}

test('readOwnedGames maps collectionStore apps to OwnedGame[]', async () => {
  fakeCollection([{
    appid: 244210, display_name: 'Assetto Corsa', app_type: 1,
    minutes_playtime_forever: 2716, rt_purchased_time: 1604247205,
    rt_steam_release_date: 1418978880, metacritic_score: 85, size_on_disk: '12345',
  }]);
  const { games, ready } = await readOwnedGames();
  expect(ready).toBe(true);
  expect(games[0]).toEqual({
    appid: 244210, name: 'Assetto Corsa', appType: 1, playtimeForeverMinutes: 2716,
    playtimeTwoWeeksMinutes: undefined, purchasedAt: 1604247205, releaseAt: 1418978880,
    lastPlayedAt: undefined, metacritic: 85, sizeOnDiskBytes: 12345,
  });
});

test('readOwnedGames returns ready=false when collection never populates', async () => {
  (globalThis as any).window = {};
  const { games, ready } = await readOwnedGames(50);
  expect(ready).toBe(false);
  expect(games).toEqual([]);
});

// Family Sharing: collectionStore.allGamesCollection answers "what can I see",
// not "what do I own" — borrowed games are in there because the user can launch
// them. Steam's own predicate is
//   BIsBorrowed() { return this.BIsOwned() && !!this.owner_account_id }
// so a set owner_account_id means the copy belongs to someone else.
test('readOwnedGames excludes family-shared games', async () => {
  fakeCollection([
    { appid: 1, display_name: 'Mine', app_type: 1 },
    { appid: 2, display_name: 'Borrowed from family', app_type: 1, owner_account_id: 123456 },
    { appid: 3, display_name: 'Also mine', app_type: 1 },
  ]);
  const { games, familySharedExcluded } = await readOwnedGames();
  expect(games.map((g) => g.appid)).toEqual([1, 3]);
  expect(familySharedExcluded).toBe(1);
});

test('readOwnedGames reports zero exclusions for a library with no shared games', async () => {
  fakeCollection([{ appid: 1, display_name: 'Mine', app_type: 1 }]);
  const { games, familySharedExcluded } = await readOwnedGames();
  expect(games.length).toBe(1);
  expect(familySharedExcluded).toBe(0);
});

test('readOwnedGames treats a library of only borrowed games as ready but empty', async () => {
  fakeCollection([
    { appid: 2, display_name: 'Borrowed', app_type: 1, owner_account_id: 123456 },
  ]);
  const { games, ready, familySharedExcluded } = await readOwnedGames();
  expect(ready).toBe(true);
  expect(games).toEqual([]);
  expect(familySharedExcluded).toBe(1);
});
