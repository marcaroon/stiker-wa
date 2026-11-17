// Tiny IndexedDB wrapper for the sticker collection.

export interface SavedSticker {
  id: string;
  blob: Blob;
  animated: boolean;
  bytes: number;
  created: number;
}

const DB = 'stiker-wa';
const STORE = 'stickers';

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error);
  });
}

export const saveSticker = (s: Omit<SavedSticker, 'id' | 'created'>) =>
  tx('readwrite', (st) => st.put({ ...s, id: crypto.randomUUID(), created: Date.now() }));

export const listStickers = async () =>
  ((await tx('readonly', (st) => st.getAll())) as SavedSticker[]).sort((a, b) => b.created - a.created);

export const deleteSticker = (id: string) => tx('readwrite', (st) => st.delete(id));
