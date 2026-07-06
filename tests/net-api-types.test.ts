import { test, expect } from 'bun:test';
import type { SbApi, NetApi, NetResponse } from '../src/api/api-types';

test('SbApi has a net namespace of type NetApi', () => {
  // compile-time: assign a stub NetApi to SbApi['net']
  const net: NetApi = {
    async fetch() {
      const r: NetResponse = {
        ok: true, status: 200, headers: {},
        text: async () => '', json: async () => ({}),
      };
      return r;
    },
  };
  const slot: SbApi['net'] = net;
  expect(typeof slot.fetch).toBe('function');
});
