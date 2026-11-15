CREATE TABLE IF NOT EXISTS notes (
 path TEXT PRIMARY KEY, content TEXT NOT NULL, lower_content TEXT NOT NULL,
 bytes INTEGER NOT NULL, modified TEXT, etag TEXT, indexed_at TEXT NOT NULL,
 seen_generation TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Additive migration: existing notes, index and OAuth grants are unchanged.
CREATE TABLE IF NOT EXISTS shared_activity (
 vault TEXT NOT NULL,
 event_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 project TEXT NOT NULL,
 task_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 vault_synced INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (vault,event_id)
);
CREATE INDEX IF NOT EXISTS shared_activity_recent ON shared_activity(vault,occurred_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS shared_activity_project ON shared_activity(vault,project,occurred_at DESC,event_id DESC);
