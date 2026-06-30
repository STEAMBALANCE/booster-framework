import type { GetAccountLevelRequest } from './protocol';
import type { RelayPoster } from './channel';
import { fetchAccountLevel } from '../steam-internals/account-level';

export async function handleGetAccountLevel(msg: GetAccountLevelRequest, bc: RelayPoster): Promise<void> {
  let level: number | undefined;
  try { level = await fetchAccountLevel(msg.accountId); } catch { level = undefined; }
  bc.postMessage({ kind: 'account-level-ok', requestId: msg.requestId, level });
}
