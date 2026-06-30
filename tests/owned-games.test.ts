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
