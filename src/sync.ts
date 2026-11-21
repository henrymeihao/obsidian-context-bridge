import { listDirectory, readNote, type Entry } from './read.js';
import { type SearchEnv } from './search.js';
interface SyncState {
 generation: string; queue: { path: string; offset: number }[]; pending: Entry[];
 complete: boolean; skipped: string[]; nextScanAfter?: number; lastError?: string;
 retries?: Record<string, { attempts: number; after: number; code: string }>;
 deferred?: { path: string; offset: number; entry?: Entry }[];
 checkpointAt?: string; lastProgressAt?: string;
 retiredDirectories?: number;
 // Only a traversal started at the root by this implementation may prune.
 pruneSafe?: boolean; rescanReason?: string;
}
const MAX_SCAN_AGE_MS = 24 * 60 * 60 * 1000;
function freshScan(previous?: SyncState): SyncState {
  return {generation:new Date().toISOString(),queue:[{path:'',offset:0}],pending:[],complete:false,skipped:[],pruneSafe:true,
    ...(previous?{rescanReason:'expired_or_untrusted_generation',retiredDirectories:previous.retiredDirectories,lastProgressAt:previous.lastProgressAt}:{})};
}
const isoTime = (value:string|null|undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function syncErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const status = /^WebDAV read failed \((\d{3})\)\.$/.exec(message)?.[1];
  if (status) return `webdav_${status}`;
  if (error instanceof Error && /Timeout|Abort/.test(error.name)) return 'timeout';
  if (message === 'File changed during indexing') return 'source_changed';
  if (/^WebDAV returned /.test(message)) return 'directory_format';
  if (/^Note or directory exceeds/.test(message)) return 'response_size';
  return 'storage_or_network';
}
export async function syncIndex(env: SearchEnv, fetcher: typeof fetch = fetch) {
  const db = env.SEARCH_DB;
  if (!db || env.ACCESS_MODE !== 'vault') return;
  const now = Date.now(), lease = String(now + 120000);
  const acquired = await db.prepare(`INSERT INTO index_meta(key,value) VALUES('sync_lock',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(index_meta.value AS INTEGER)<? RETURNING value`).bind(lease, now).first();
  if (!acquired) return;
  try { await runSync(env, fetcher); }
  finally { await db.prepare("DELETE FROM index_meta WHERE key='sync_lock' AND value=?").bind(lease).run(); }
}
async function runSync(env: SearchEnv, fetcher: typeof fetch) {
  const db = env.SEARCH_DB;
  if (!db || env.ACCESS_MODE !== 'vault') return;
  const root = await db.prepare("SELECT value FROM index_meta WHERE key='root'").first<string>('value');
  if (root !== env.WEBDAV_ROOT) {
    await db.prepare("INSERT OR REPLACE INTO index_meta(key,value) VALUES('sync_diagnostic',?)").bind('root_mismatch').run();
    return;
  }
  await db.prepare("DELETE FROM index_meta WHERE key='sync_diagnostic'").run();
  const saved = await db.prepare("SELECT value FROM index_meta WHERE key='sync_state'").first<string>('value');
  let state: SyncState = saved ? JSON.parse(saved) : { generation: '', queue: [], pending: [], complete: true, skipped: [] };
  if (state.complete) {
    if (state.nextScanAfter && Date.now() < state.nextScanAfter) return;
    state = freshScan();
  }
  let requests = 0;
  state.retries ??= {}; state.deferred ??= [];
  for (const item of [...state.deferred]) if ((state.retries[item.path]?.after ?? 0) <= Date.now()) {
    if (item.entry) state.pending.push(item.entry); else state.queue.push({path:item.path,offset:item.offset});
    state.deferred.splice(state.deferred.indexOf(item),1);
  }
  const checkpoint = async () => {
    state.checkpointAt = new Date().toISOString();
    await db.prepare("INSERT OR REPLACE INTO index_meta(key,value) VALUES('sync_state',?)").bind(JSON.stringify(state)).run();
  };
  const deadline = Date.now() + 25000;
  try {
    while (requests < 10 && Date.now() < deadline && (state.pending.length || state.queue.length)) {
      // Persist each completed item/page; an interrupted Worker resumes from this checkpoint.
      await checkpoint();
      const workPath = state.pending[0]?.path ?? state.queue[0].path;
      try {
      if (state.pending.length) {
        const entry = state.pending[0];
        requests++;
        try {
          // Two copies (original and folded) must fit in one D1 row.
          if (entry.bytes != null && entry.bytes > 500 * 1024) throw new Error('Index size limit');
          const note = await readNote(env, entry.path, fetcher, { length: 30000 });
          let content = note.text;
          for (let offset = note.nextOffset; offset != null;) {
            if (Date.now() >= deadline) throw new DOMException('Time budget', 'TimeoutError');
            const part = await readNote(env, entry.path, fetcher, { offset, length: 30000 });
            requests++; content += part.text; offset = part.nextOffset;
            if (part.etag !== note.etag) throw new Error('File changed during indexing');
          }
          if (new TextEncoder().encode(content).length > 500 * 1024) throw new Error('Index size limit');
          await db.prepare(`INSERT INTO notes(path,content,lower_content,bytes,modified,etag,indexed_at,seen_generation) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(path) DO UPDATE SET content=excluded.content,lower_content=excluded.lower_content,bytes=excluded.bytes,modified=excluded.modified,etag=excluded.etag,indexed_at=excluded.indexed_at,seen_generation=excluded.seen_generation`)
            .bind(entry.path, content, content.toLowerCase(), new TextEncoder().encode(content).length, isoTime(note.lastModified || entry.lastModified), note.etag || entry.etag || null, new Date().toISOString(), state.generation).run();
          state.pending.shift();
          delete state.retries[entry.path]; state.lastProgressAt = new Date().toISOString();
        } catch (error) {
          if (error instanceof Error && (error.message === 'Index size limit' || /WebDAV read failed \(404\)/.test(error.message))) {
            state.skipped.push(entry.path);
            state.pending.shift();
            // Do not continue serving an obsolete copy of a deleted/now-oversized note.
            await db.prepare('DELETE FROM notes WHERE path=?').bind(entry.path).run();
          } else throw error;
        }
        await checkpoint(); continue;
      }
      const current = state.queue[0];
      requests++;
      const page = await listDirectory(env, current.path, current.offset, 200, fetcher);
      if (page.serverMayHaveMore && !state.skipped.includes('[directory listing may be truncated]')) state.skipped.push('[directory listing may be truncated]');
      const entries = page.entries.filter(e => e.type === 'note');
      const old = entries.length ? await db.prepare('SELECT path,bytes,modified,etag FROM notes WHERE path IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(entries.map(e => e.path))).all<{ path: string; bytes: number; modified: string | null; etag: string | null }>() : { results: [] };
      const map = new Map(old.results.map(r => [r.path, r]));
      const unchanged: { path: string; etag: string | null; modified:string|null }[] = [];
      for (const entry of entries) {
        const previous = map.get(entry.path);
        const same = previous && (previous.etag && entry.etag ? previous.etag === entry.etag
          : previous.bytes === entry.bytes && previous.modified && entry.lastModified && Math.floor(Date.parse(previous.modified) / 1000) === Math.floor(Date.parse(entry.lastModified) / 1000));
        if (same) unchanged.push({ path: entry.path, etag: entry.etag || previous.etag, modified:isoTime(entry.lastModified||previous.modified) });
        else state.pending.push(entry);
      }
      if (unchanged.length) await db.prepare(`UPDATE notes SET seen_generation=?, etag=COALESCE((SELECT json_extract(value,'$.etag') FROM json_each(?) WHERE json_extract(value,'$.path')=notes.path),etag),
        modified=COALESCE((SELECT json_extract(value,'$.modified') FROM json_each(?) WHERE json_extract(value,'$.path')=notes.path),modified)
        WHERE path IN (SELECT json_extract(value,'$.path') FROM json_each(?))`).bind(state.generation, JSON.stringify(unchanged), JSON.stringify(unchanged), JSON.stringify(unchanged)).run();
      for (const entry of page.entries) if (entry.type === 'directory') state.queue.push({ path: entry.path, offset: 0 });
      if (page.nextOffset == null) state.queue.shift(); else current.offset = page.nextOffset;
      delete state.retries[workPath]; state.lastProgressAt = new Date().toISOString();
      } catch (error) {
        const previous = state.retries[workPath]?.attempts ?? 0;
        const code = syncErrorCode(error);
        if(code==='webdav_404' && workPath!=='' && !state.pending.length) {
          // A queued folder may have been renamed/deleted since the earlier listing.
          // Root 404 is never interpreted as an empty vault.
          state.queue.shift(); delete state.retries[workPath];
          state.retiredDirectories=(state.retiredDirectories??0)+1;
          state.lastProgressAt=new Date().toISOString(); await checkpoint(); continue;
        }
        state.retries[workPath] = {attempts:previous+1,after:Date.now()+Math.min(3600000,30000*2**Math.min(previous,7)),code};
        state.lastError = code;
        if (state.pending.length && state.pending[0].path === workPath) state.deferred.push({path:workPath,offset:0,entry:state.pending.shift()!});
        else state.deferred.push(state.queue.shift()!);
      }
      await checkpoint();
    }
    if (!state.deferred.length) delete state.lastError;
    if (!state.queue.length && !state.pending.length && !state.deferred.length) {
      const age = Date.now() - Date.parse(state.generation);
      if (!state.pruneSafe || !Number.isFinite(age) || age < 0 || age > MAX_SCAN_AGE_MS) {
        // Preserve indexed content and completed updates from an old/interrupted scan.
        // Queue a new root traversal for the next invocation; never loop here or
        // advance last_full_scan_at using stale directory evidence.
        state = freshScan(state);
      } else {
        if (!state.skipped.includes('[directory listing may be truncated]')) await db.prepare('DELETE FROM notes WHERE seen_generation<>?').bind(state.generation).run();
        await db.prepare("INSERT OR REPLACE INTO index_meta(key,value) VALUES('last_full_scan_at',?)").bind(new Date().toISOString()).run();
        state.complete = true;
        state.nextScanAfter = Date.now() + 2 * 60000;
      }
    }
  } catch (error) {
    // Retain the work item and retry later. Do not persist credentials or upstream response bodies.
    state.lastError = syncErrorCode(error);
  }
  await checkpoint();
}
