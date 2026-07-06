import { test, expect } from 'bun:test';
import { Capability } from '../src/api/api-types';

test('Capability.Net exists and equals "net"', () => {
  expect(Capability.Net).toBe('net');
});
