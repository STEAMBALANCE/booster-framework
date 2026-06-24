declare global {
  var __SB_RELAY_TOKEN__: string | undefined;
}

export const RELAY_AUTH_FIELD = '__sbRelayToken';

export type RelayAuthToken = string | undefined;

export function readRelayAuthToken(): RelayAuthToken {
  const token = globalThis.__SB_RELAY_TOKEN__;
  return typeof token === 'string' && token.length >= 32 ? token : undefined;
}

export function withRelayAuth<T extends Record<string, unknown>>(
  msg: T,
  token: RelayAuthToken,
): T {
  return token ? { ...msg, [RELAY_AUTH_FIELD]: token } : msg;
}

export function hasValidRelayAuth(msg: unknown, token: RelayAuthToken): boolean {
  if (!token) return true;
  if (!msg || typeof msg !== 'object') return false;
  return (msg as Record<string, unknown>)[RELAY_AUTH_FIELD] === token;
}
