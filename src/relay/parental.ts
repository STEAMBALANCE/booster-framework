import type { GetParentalStateRequest } from './protocol';
import type { RelayPoster } from './channel';
import type { ParentalState } from '../api/api-types';
import { readParentalState } from '../steam-internals/parental';

export async function handleGetParentalState(msg: GetParentalStateRequest, bc: RelayPoster): Promise<void> {
  let state: ParentalState | undefined;
  try { state = await readParentalState(); } catch { state = undefined; }
  bc.postMessage({ kind: 'parental-state-ok', requestId: msg.requestId, state });
}
