# Phase 4B — bounded recall and CPU diagnosis

Date: 2026-11-22. Production baseline remains `b2d239d`; failed candidate is `73e7b3b`. This is a **local implementation and isolation report, not production release approval**. No deployment, production database migration, installed Skill update, history import or production personal-memory write was performed.

## Findings and changes

The 4A failure log contains `exceededCpu` / `Worker exceeded CPU time limit`. Reproduction uses the frozen pre-rollout backup (765 notes, 80 Activity, one Memory) locally and read-only. None of its note bodies, paths or ground-truth queries are included in this document or public fixtures.

The old implementation transferred up to 201 complete notes into Worker JavaScript, normalized/scored each full body, then split and scored **every line of every candidate** before selecting Top 5. Each score call normalized query terms and constructed regular expressions again. A candidate-count limit therefore did not bound the amount of text or the number of scoring calls. The subsequent duplicate check also repeatedly allocated/scanned prefixes of the hit array.

Bilingual expansion itself was finite (exact/gram/expansion caps), with one SQL candidate query per store, not a per-synonym request fan-out. It amplified the broad candidate workload but was not an unbounded query loop. Sorting at this scale was not the main hotspot.

A separate SQL defect suppressed path/title matching: `json_each` exposes its own `path` column. Unqualified `path` inside the correlated candidate subquery resolved to the JSON path, not `notes.path`. All ten original targets happened to enter the old candidates through body matches; a title-only desensitized regression exposed the candidate-generation defect. Note and topic predicates now qualify their columns.

The implementation now:

- compiles query matchers once per request and keeps bilingual/NFKC/stage expansion;
- prioritizes original terms before applying a 128-token SQL cap;
- overfetches four times the requested limit, minimum 16, maximum 64 per store, further bounded by a 2,048 candidate×token budget; one additional row detects truncation;
- materializes note candidate scores once in SQLite and uses existing `lower_content`; no full note body is transferred for scoring;
- transfers matched terms and, only for stage queries, at most 512 prefix characters plus two short stage hints;
- weights actual paths/titles and rare Chinese title grams, so a short subject-specific note can outrank a broad diary;
- scores candidates once, sorts, and deduplicates with a Set;
- retrieves at most one 1,000-character line fragment per emitted note in **one SQL query**, via primary-key joins; no per-line rescoring;
- normalizes CRLF/CR before locating excerpts and calculating source lines;
- checks `indexed_at` across ranking/extraction; a changed/disappeared row is omitted and incomplete coverage is flagged;
- reuses index-status metadata for the root check and skips the heads query when no Memory candidates exist.

`candidate_truncated` includes token/candidate caps and source changes. A cap is incomplete coverage, not evidence that other memories do not exist. `limit` remains an upper bound, not a guarantee of that many results. Memory validity/supersession, Activity current-task selection, conflicts, source evidence, root isolation and OAuth write guards remain in place. No schema/index migration or new service is required.

## Measurement discipline

Three separate measurements were used:

1. Node/SQLite diagnostic: phase wall times, SQL calls/rows/text sizes, OS process CPU for synchronous SQL, coarse non-SQL CPU by subtraction, and heap delta. This is **not Worker CPU**.
2. Local workerd with actual D1 bindings: the original ten requests, candidate counts, query wall times, V8 CPU profiles and heap point measurements. V8 profile `timeDeltas` can include I/O/suspension charged to the last JS frame; their sum is **not** a CPU duration. Profiles identify hot frames only.
3. Fresh local workerd processes with the SQLite adapter in the parent Node process: Windows `TotalProcessorTime` deltas over batches, excluding SQLite's CPU. These are actual **whole-workerd-process CPU averages**, including local bridge/runtime overhead, not per-isolate or Cloudflare billed CPU. Old: three repetitions/question; new: ten. OS timer granularity and GC limit precision. They do not establish a per-invocation percentile or a production CPU limit pass.

Cloudflare documents both the distinction from wall time and the need for CPU profiling: [CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/), [limits](https://developers.cloudflare.com/workers/platform/limits/).

|Metric on frozen real corpus|73e7b3b|4B local|
|---|---:|---:|
|Whole-workerd-process CPU, median batch average/request|455.73 ms|9.375 ms|
|Whole-workerd-process CPU, range of question averages|177.08–760.42 ms|4.69–14.06 ms|
|workerd + local D1 wall time, median|910.66 ms|216.25 ms|
|Observed workerd heap points, range (decimal MB)|14.03–62.55|4.53–6.18|
|Note candidate text characters, median|897,492|244.5|
|SQL calls/request|8|7–8|

The candidate-text metric excludes paths, JSON overhead and final excerpts. Heap values are point samples, not peaks. Wall, process CPU and heap were measured in different runs and must not be subtracted from one another. Stage details, row counts, token counts and memory observations are retained locally under `work/phase4b/`.

**The dominant CPU workload is removed, but a strict 10 ms production CPU gate is NOT certified.** Three final local process-average observations exceed 10 ms (questions 4, 8 and 9); these include bridge overhead and are not proof of three Cloudflare violations either. Local Miniflare success does not enforce Cloudflare's billed per-invocation CPU limit. MCP/OAuth protocol overhead also needs budget measurement in the next authorized isolated preflight. No production error rate can be claimed from this run. Do not release on the strength of the median alone.

## Ten-question source and failure audit

All ten expected sources exist in the frozen backup, have the originally labelled content hashes, are within that snapshot's permitted root, and entered the original SQL candidates. Thus this set supplies no evidence of category A (missing original data). Sources are historical Markdown evidence, not automatically current personal facts. Their present live WebDAV existence was not rechecked in this local-only round.

Classification: A missing data; B candidate generation; C ranking; D time/version/evidence; E tool execution. Categories can overlap. SQL path shadowing is a confirmed B defect on the independent title-only regression, not an excuse to reclassify these ten old candidates as absent.

|ID/category|Old local target rank in Top 5|4A production|4B local target rank|Diagnosis|
|---|---:|---|---:|---|
|1 career|outside|miss|3|C: title/path underweighted, broad body coverage wins|
|2 career|outside|error|1|E plus underlying C|
|3 travel|outside|miss|1|C: destination/date title loses to broad travel coverage|
|4 travel|outside|miss|1|C: specific short source loses to broad notes|
|5 AI|1|hit|1|No source/candidate/ranking failure reproduced|
|6 AI|1|error|1|E; ranking works without production CPU enforcement|
|7 life|outside|error|1|E plus underlying C|
|8 life|outside|error|1|E plus underlying C|
|9 project|3|hit|1|Hit retained; title ranking improved|
|10 project|1|hit|2|Hit retained|

The local target ranks are checked against the fixed pre-query labels; full source paths and hashes stay in the ignored private ground truth and `work/phase4b/diagnosis.json`. This table is the ten known regression questions, **not a blind/representative semantic benchmark**. The improvement must be checked on new sourced questions in later acceptance.

- Historical 4A production: target-source Recall@5 **3/10**, four tool errors.
- Old code on the isolated frozen corpus, without production CPU enforcement: **4/10**. Question 6 explains the extra hit; this does not rewrite the production outcome.
- Current local Node/SQLite and actual workerd/D1: **10/10**, no local invocation error.
- All 44 returned note fragments across these ten current local queries were checked against their indexed source lines: zero fragment/line mismatches. This is not a relevance precision score or live WebDAV verification.
- Separate fictional 20-question benchmark: **90%**, unchanged; two untuned semantic paraphrases still miss. It is not the real-history metric.

No missing personal record was invented to improve scores. No category D validity/supersession error was established in these ten questions; the travel error was entity/ranking coverage, not evidence that a trip occurred in a different state. Existing temporal/conflict tests remain required. Dates embedded in prose are not a general temporal reasoning engine.

## Regression and boundaries

- `npm run check`: passed.
- `npm test`: **72/72**, including all original 66 tests.
- Complete isolated current Worker/D1/KV/OAuth/WebDAV rehearsal: **13/13**. It exercises old read/Activity/diet tools, memory scope denial for old grants, verified/idempotent writes, revision/timeline, retry/conflicts, index 404 handling and safe generation recovery, and local rollback compatibility with the real b2d239d bundle. All writes are fictional and confined to isolated storage.
- Added structurally desensitized natural questions with independent subjects; no production note paths or articles in public tests.
- Long-text tail matches, three newline conventions, title-only/topic filters, deep contradictory stage hints, maximum query length/large candidate sets, source changes and bounded payload/query count are tested. The workerd integration exercises long notes and three query languages with external traffic forbidden.

Remaining limits: D1 still performs lexical scans within filtered notes; candidate result caps do not make database scan cost independent of corpus size. Finite expansion is not a translator. Stage hints and bounded candidates are not complete arbitrary-document semantic reasoning. Candidate truncation may need a refined query. Markdown remains unclassified evidence. ChatGPT's missing full tool trace is a separate client limitation and was not declared fixed by backend testing. No installed Skills were changed.

## Repeat locally and next gate

Keep private cases as `{ "cases": [{ "id": 1, "query": "...", "expected": "vault-relative-path.md" }] }`. Use an already restored local backup, never a production binding:

```powershell
npx tsx scripts/profile-recall.ts --db=<local-restored.sqlite> --cases=<private-cases.json> --out=work/recall-profile --baseline=73e7b3b
npm run check
npm test
```

The diagnostic opens SQLite read-only and accepts output only under ignored `work/`; its report contains IDs/counts/timing, not queries, paths or note text. The optional `recallMemory` observer emits only phase/count/wall-time data and is not enabled/logged by the MCP tool.

This patch is ready for review and a **new performance preflight**, not automatic production deployment. Required before release: confirm the actual account CPU budget, establish per-invocation CPU headroom with the full MCP wrapper in an authorized isolated environment, and test new independently labelled historical queries. Production, migrations, installed Skills and personal memory remain outside this round's mutation scope.
