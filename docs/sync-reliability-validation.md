# Sync reliability validation

Validated locally on 2026-11-24 against production baseline `139a5bf`.

## Changes

Memory topic refresh failures now persist a fixed error code in `memory_views` without replacing the last generated content. The scheduled task keeps its error marker while any topic remains unresolved, including topics outside the current three-topic batch. A successful refresh clears that topic's error. Manual edits and conditional writes remain protected.

Activity retries retain a vault-scoped cursor pointing to the last attempted event. Pending events rotate in `(recorded_at,event_id)` order, with the existing five-event budget. The cursor is saved before each attempt, so an interrupted attempt cannot permanently pin the queue head. Unsynced events remain immutable and queued; the error marker stays until the queue drains. This is fair scheduling, not exponential backoff.

No schema migration, index synchronization change, scan exclusion, Cron frequency change or sampling change is required. This release fixes reliability; it does not claim an I/O reduction. Cursor persistence and error checks add D1 operations.

## Reproduction and checks

Reused the filename integration harness: real workerd, local D1, synthetic WebDAV, real scheduled handler and MCP filename query. The shared harness is `test/workerd-fixture.mjs`; reliability scenarios are in `test/sync-reliability.integration.mjs`. All outbound requests terminate in the mock. Tests load no production configuration, secrets, D1, KV or real files.

Before fixes:

- Topic GET 503 left both topic and background errors null, although a later round recovered its content.
- One failed Activity head allowed later events to progress.
- Five failed Activity heads kept all eight events unsynced after four scheduled rounds; the three healthy tail events received no progress.

After fixes:

|Scenario|Result|
|---|---|
|Memory GET and PUT 503|`webdav_retry` persists; background error survives a healthy-topic round; recovery clears both|
|Memory manual edit|Original text retained, no overwrite, `manual_view_conflict` visible|
|Activity one failed head|State `[0,1,1,1,1,1,1,1]`, then all synced after recovery|
|Activity five failed heads|State `[0,0,0,0,0,1,1,1]`, then all synced after recovery|
|Index checkpoint write outage|Dispose/restart workerd with the same dedicated local D1; resume directory offset 200 and the same generation|
|205-note lifecycle|Addition, modification, rename and exact GET404 deletion agree with exhaustive filename_indexed pagination|
|Directory 503|Old content retained, early retry suppressed, deferred item recovers in the same generation; sweeping waits for a clean generation|
|Repeated run|No duplicate paths, no extra Activity PUT after recovery, completed index remains unchanged|
|Cleanup|All fixture-test notes removed through real sync; unrelated sentinel retained; dedicated local persistence directory removed|

The modified note changed from `Original 0`, ETag `1`, Last-Modified `2030-01-01T00:00:00.000Z` to `Modified evidence`, ETag `2`, Last-Modified `2030-01-02T00:00:00.000Z`. These dates and all content are synthetic. The unrelated sentinel retained its content, ETag and modification time.

Commands: `npm test` (84/84), `npm run check`, `git diff --check`. The actual Wrangler release bundle also passed all seven integration scenarios using `OCB_TEST_BUNDLE=./work/reliability-bundle/index.js node --test test/sync-reliability.integration.mjs test/filename-worker.integration.mjs`. The finite privacy scan reported zero findings across 68 files; this is not a full security audit. The injected checkpoint outage is a controlled D1 write failure followed by a workerd restart, not a simulation of every possible process-kill timing. Runtime latency, all possible concurrent interleavings, and production index completeness are not certified by these tests.
