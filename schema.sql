CREATE TABLE IF NOT EXISTS notes (
 path TEXT PRIMARY KEY, content TEXT NOT NULL, lower_content TEXT NOT NULL,
 bytes INTEGER NOT NULL, modified TEXT, etag TEXT, indexed_at TEXT NOT NULL,
 seen_generation TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
