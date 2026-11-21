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

-- Additive only; no changes to Activity, notes or existing OAuth grants.
CREATE TABLE IF NOT EXISTS personal_memory (
 vault TEXT NOT NULL, memory_id TEXT NOT NULL, topic TEXT NOT NULL, type TEXT NOT NULL,
 payload TEXT NOT NULL, fingerprint TEXT NOT NULL, dedup_key TEXT NOT NULL,
 supersedes TEXT, revision INTEGER NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
 vault_synced INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 retry_after INTEGER NOT NULL DEFAULT 0, sync_error TEXT,
 PRIMARY KEY(vault,memory_id), UNIQUE(vault,dedup_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_revision_parent ON personal_memory(vault,supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_topic ON personal_memory(vault,topic,type,occurred_at);
CREATE INDEX IF NOT EXISTS memory_queue ON personal_memory(vault,vault_synced,retry_after);
CREATE TABLE IF NOT EXISTS memory_views (
 vault TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL, sync_error TEXT,
 PRIMARY KEY(vault,topic)
);
