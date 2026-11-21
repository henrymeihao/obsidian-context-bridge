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
