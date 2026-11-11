import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const globalStore = globalThis as unknown as { db?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (globalStore.db) return globalStore.db;

  const folder = path.join(process.cwd(), 'data');
  fs.mkdirSync(folder, { recursive: true });

  const db = new DatabaseSync(path.join(folder, 'agent.db'));

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      sources    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

    -- Full-text search over message text, so old conversations can be found by topic.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
      content,
      content = 'messages',
      content_rowid = 'id'
    );
    -- Copy every new message into the search table automatically.
    CREATE TRIGGER IF NOT EXISTS messages_after_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
    END;
    -- Make sure messages saved before the search table existed are in it too.
    INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');

    -- Recent web searches, so repeating a search is instant.
    CREATE TABLE IF NOT EXISTS search_cache (
      query      TEXT PRIMARY KEY,
      results    TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);

  globalStore.db = db;
  return db;
}