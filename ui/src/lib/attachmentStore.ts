import type { PendingAttachment } from "../components/sessions/attachments";

/**
 * Persistencia local de adjuntos pendientes por sesión (IndexedDB).
 * Los data URLs pueden pesar; se limpian a los 7 días y al enviar/borrar.
 */
const DB_NAME = "factory-console";
const STORE = "attachments";
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

let database: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (database) return database;
  database = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = null;
      resolve(null);
    };
    request.onblocked = () => {
      database = null;
      resolve(null);
    };
  });
  return database;
}

interface StoredAttachments {
  files: PendingAttachment[];
  updatedAt: number;
}

export async function readAttachments(sessionId: string): Promise<PendingAttachment[]> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(sessionId);
    request.onsuccess = () => {
      const value = request.result as StoredAttachments | undefined;
      if (!value || Date.now() - value.updatedAt > MAX_AGE_MS) {
        resolve([]);
        return;
      }
      resolve(Array.isArray(value.files) ? value.files : []);
    };
    request.onerror = () => resolve([]);
  });
}

export async function writeAttachments(sessionId: string, files: PendingAttachment[]): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    if (files.length === 0) store.delete(sessionId);
    else store.put({ files, updatedAt: Date.now() } satisfies StoredAttachments, sessionId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function deleteAttachments(sessionId: string): Promise<void> {
  await writeAttachments(sessionId, []);
}

export async function pruneAttachments(): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as StoredAttachments;
      if (!value || Date.now() - value.updatedAt > MAX_AGE_MS) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}
