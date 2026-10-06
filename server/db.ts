import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Where this machine's Meadowlark data lives. MEADOWLARK_HOME overrides it (tests, a second instance). */
export function dataDir(): string {
  return process.env.MEADOWLARK_HOME ?? join(homedir(), ".meadowlark");
}

export function defaultDbPath(): string {
  return join(dataDir(), "meadowlark.db");
}

// Both the app server and every Claude session's MCP server open this file.
// WAL lets them read while another writes; busy_timeout makes a writer wait
// for the lock instead of failing.
const MIGRATIONS = [
  `CREATE TABLE pages (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     ord REAL NOT NULL,
     repo TEXT,
     elements TEXT NOT NULL DEFAULT '[]',
     app_state TEXT NOT NULL DEFAULT '{}',
     claude_change TEXT
   );
   CREATE TABLE views (
     page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
     scroll_x REAL NOT NULL,
     scroll_y REAL NOT NULL,
     zoom REAL NOT NULL
   );
   CREATE TABLE files (
     page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
     file_id TEXT NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (page_id, file_id)
   );
   CREATE TABLE queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     edit TEXT NOT NULL
   );
   CREATE INDEX queue_page ON queue(page_id, id);
   CREATE TABLE snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     reason TEXT NOT NULL,
     elements TEXT NOT NULL,
     app_state TEXT NOT NULL,
     files TEXT NOT NULL
   );
   CREATE INDEX snapshots_page ON snapshots(page_id, id);`,
  // Until now only Claude's pages had a repo, so that's how existing ones are found.
  `ALTER TABLE pages ADD COLUMN by_claude INTEGER NOT NULL DEFAULT 0;
   UPDATE pages SET by_claude = 1 WHERE repo IS NOT NULL;`,
  `ALTER TABLE pages ADD COLUMN pinned_at INTEGER;`,
];

export function openDb(path = defaultDbPath()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (current >= MIGRATIONS.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read inside the lock: another process may have migrated meanwhile.
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = version; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
