import { openDB, type IDBPDatabase } from "idb";

interface CachedSession { id: string; lines: string[]; nextLineIndex: number }

interface StoredOutgoingImage { mime: string; data: string }

interface DbSchema {
  "session-cache": {
    key: string;
    value: CachedSession;
  };
}

const DB_NAME = "claude-webui";
// v4: drop the obsolete "message-queue" store (queue now lives in the CLI).
// v5: clear every "session-cache" entry — older backends could leave
//     the cache off-by-N (truncate handler had a stat/readFile race that
//     mis-aligned line indices). A hard Ctrl+Shift+R doesn't touch IDB, so
//     users would keep loading the broken state until they opened a private
//     tab. Bumping the version drops the entries on first load so a fresh
//     tail replay populates clean indices.
const DB_VERSION = 5;

let dbPromise: Promise<IDBPDatabase<DbSchema>> | null = null;

function getDb(): Promise<IDBPDatabase<DbSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<DbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains("session-cache")) {
          db.createObjectStore("session-cache", { keyPath: "id" });
        }
        if (oldVersion < 4 && db.objectStoreNames.contains("message-queue")) {
          db.deleteObjectStore("message-queue");
        }
        if (oldVersion < 5 && db.objectStoreNames.contains("session-cache")) {
          // Drop stale cache content — off-by-N from the truncate race.
          // Keep the store itself (schema unchanged), just empty it via the
          // in-progress upgrade transaction. Next engage() will rebuild
          // from the backend tail replay.
          tx.objectStore("session-cache").clear();
        }
      },
    });
  }
  return dbPromise;
}

export async function loadSessionCache(id: string): Promise<CachedSession | undefined> {
  const db = await getDb();
  return db.get("session-cache", id);
}

export async function saveSessionCache(value: CachedSession): Promise<void> {
  const db = await getDb();
  await db.put("session-cache", value);
}

export async function clearSessionCache(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("session-cache", id);
}

export type { StoredOutgoingImage };
