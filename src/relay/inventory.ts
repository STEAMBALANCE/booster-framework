import type { GetInventoryRequest } from './protocol';
import type { RelayPoster } from './channel';
import type { InventoryResult } from '../api/api-types';
import { fetchInventory } from '../steam-internals/inventory';

export async function handleGetInventory(msg: GetInventoryRequest, bc: RelayPoster): Promise<void> {
  let result: InventoryResult;
  try { result = await fetchInventory(msg.options); }
  catch { result = { items: [], perApp: [], partial: true }; }
  bc.postMessage({ kind: 'inventory-ok', requestId: msg.requestId, result });
}
