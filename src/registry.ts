export interface MutationEntry {
  id: number;
  description: string;
  undo: () => void;
}

export interface Registry {
  push(entry: Omit<MutationEntry, 'id'>): number;
  remove(id: number): void;
  rollbackAll(): void;
  size(): number;
}

export function createRegistry(): Registry {
  let nextId = 1;
  const entries: MutationEntry[] = [];

  return {
    push(entry) {
      const id = nextId++;
      entries.push({ id, ...entry });
      return id;
    },
    remove(id) {
      const i = entries.findIndex(e => e.id === id);
      if (i >= 0) entries.splice(i, 1);
    },
    rollbackAll() {
      const copy = entries.slice().reverse();
      entries.length = 0;
      for (const e of copy) {
        try { e.undo(); }
        catch (err) {
          if (typeof window !== 'undefined' && window.__sb_native) {
            try {
              window.__sb_native(JSON.stringify({
                op: 'log',
                kind: 'notify',
                pluginId: 'booster-framework',
                args: { level: 'warn', msg: 'undo threw',
                        meta: { description: e.description, error: String(err) } }
              }));
            } catch { /* swallow */ }
          }
        }
      }
    },
    size() { return entries.length; },
  };
}
