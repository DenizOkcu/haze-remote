import type { DeviceCredential } from '../shared/crypto.js';

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('haze-remote', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('device');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser credential storage is unavailable'));
    request.onblocked = () => reject(new Error('Close other haze-remote tabs to access browser storage'));
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('device', mode);
      const request = action(tx.objectStore('device'));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error('Browser credential storage failed'));
    });
  } finally { db.close(); }
}
export async function loadCredential(): Promise<DeviceCredential | undefined> {
  const value = await transaction('readonly', store => store.get('current'));
  if (value && /^[a-f0-9]{32}$/.test(value.serverId) && /^[a-f0-9]{32}$/.test(value.deviceId) && /^[a-f0-9]{64}$/.test(value.password) && typeof value.serverPublicKey === 'string') return value;
}
export function saveCredential(value: DeviceCredential) { return transaction('readwrite', store => store.put(value, 'current')); }
export function forgetCredential() { return transaction('readwrite', store => store.delete('current')); }
