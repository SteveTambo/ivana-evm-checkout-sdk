/**
 * Where a payment in progress is remembered between page loads: the transfer hashes
 * this browser sent and any wallet batch it asked for. Without this, a reload or a
 * lost wallet answer could lead to paying a transfer twice.
 *
 * A store is `{ load(intentId), save(intentId, record), clear(intentId) }`.
 */

const PREFIX = "ivana.evm.payment.";

/** Keeps records in `localStorage` (survives reloads and closed tabs). */
export function localStorageStore(storage = globalThis.localStorage) {
  return {
    load(intentId) {
      try {
        const value = storage?.getItem(PREFIX + intentId);
        return value ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    },
    save(intentId, record) {
      storage?.setItem(PREFIX + intentId, JSON.stringify(record));
    },
    clear(intentId) {
      storage?.removeItem(PREFIX + intentId);
    },
  };
}

/** Keeps records in memory only: for tests, or a page that cannot use storage. */
export function memoryStore() {
  const records = new Map();
  return {
    load: (intentId) => (records.has(intentId) ? structuredClone(records.get(intentId)) : null),
    save: (intentId, record) => void records.set(intentId, structuredClone(record)),
    clear: (intentId) => void records.delete(intentId),
  };
}
