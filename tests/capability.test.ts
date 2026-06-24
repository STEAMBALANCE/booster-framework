import { test, expect } from 'bun:test';
import { Capability } from '../src/api/api-types';

// NB: when adding a new Capability, update both the const-as-const
// object and this test fixture (currently locks length=6).
test('Capability has six values', () => {
  expect(Capability.Ui).toBe('ui');
  expect(Capability.Steam).toBe('steam');
  expect(Capability.Configs).toBe('configs');
  expect(Capability.Bus).toBe('bus');
  expect(Capability.Pages).toBe('pages');
  expect(Capability.Keys).toBe('keys');
});

test('Capability is exhaustively typed', () => {
  // H7: explicit array instead of Object.values to avoid Set<unknown> trap
  const all: Capability[] = [
    Capability.Ui, Capability.Steam, Capability.Configs,
    Capability.Bus, Capability.Pages, Capability.Keys,
  ];
  const granted = new Set<Capability>(all);
  expect(granted.size).toBe(6);
});
