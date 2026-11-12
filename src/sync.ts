import { listDirectory, readNote, type Entry } from './read.js';
import { type SearchEnv } from './search.js';
interface SyncState {
 generation: string; queue: { path: string; offset: number }[]; pending: Entry[];
 complete: boolean; skipped: string[]; nextScanAfter?: number; lastError?: string;
}
export async function syncIndex(env: SearchEnv) {
  const db = env.SEARCH_DB;
  if (!db || env.ACCESS_MODE !== 'vault') return;
  const now = Date.now(), lease = String(now + 120000);
  const acquired = await db.prepare(`INSERT INTO index_meta(key,value) VALUES('sync_lock',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(index_meta.value AS INTEGER)<? RETURNING value`).bind(lease, now).first();
  if (!acquired) return;
  try { await runSync(env); }
  finally { await db.prepare("UPDATE index_meta SET value=? WHERE key='sync_lock' AND value=?").bind(String(Date.now() + 55000), lease).run(); }
}
async function runSync(env: SearchEnv) {
  const db = env.SEARCH_DB;
  if (!db || env.ACCESS_MODE !== 'vault') return;
  const root = await db.prepare("SELECT value FROM index_meta WHERE key='root'").first<string>('value');
  if (root !== env.WEBDAV_ROOT) return;
  const saved = await db.prepare("SELECT value FROM index_meta WHERE key='sync_state'").first<string>('value');
  let state: SyncState = saved ? JSON.parse(saved) : { generation: '', queue: [], pending: [], complete: true, skipped: [] };
  if (state.complete) {
    if (state.nextScanAfter && Date.now() < state.nextScanAfter) return;
    state = { generation: new Date().toISOString(), queue: [{ path: '', offset: 0 }], pending: [], complete: false, skipped: [] };
  }
  let requests = 0;
  const deadline = Date.now() + 25000;
  try {
    while (requests < 10 && Date.now() < deadline && (state.pending.length || state.queue.length)) {
      if (state.pending.length) {
        const entry = state.pending[0];
        requests++;
        try {
          // Two copies (original and folded) must fit in one D1 row.
          if (entry.bytes != null && entry.bytes > 500 * 1024) throw new Error('Index size limit');
          const note = await readNote(env, entry.path, fetch, { length: 30000 });
          let content = note.text;
          for (let offset = note.nextOffset; offset != null;) {
            if (requests >= 18) throw new Error('Index size limit');
            const part = await readNote(env, entry.path, fetch, { offset, length: 30000 });
            requests++; content += part.text; offset = part.nextOffset;
            if (part.etag !== note.etag) throw new Error('File changed during indexing');
          }
          if (new TextEncoder().encode(content).length > 500 * 1024) throw new Error('Index size limit');
          await db.prepare(`INSERT INTO notes(path,content,lower_content,bytes,modified,etag,indexed_at,seen_generation) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(path) DO UPDATE SET content=excluded.content,lower_content=excluded.lower_content,bytes=excluded.bytes,modified=excluded.modified,etag=excluded.etag,indexed_at=excluded.indexed_at,seen_generation=excluded.seen_generation`)
            .bind(entry.path, content, content.toLowerCase(), new TextEncoder().encode(content).length, note.lastModified || entry.lastModified, note.etag || entry.etag || null, new Date().toISOString(), state.generation).run();
          state.pending.shift();
        } catch (error) {
          if (error instanceof Error && (error.message === 'Index size limit' || /WebDAV read failed \(404\)/.test(error.message))) {
            state.skipped.push(entry.path);
            state.pending.shift();
            // Do not continue serving an obsolete copy of a deleted/now-oversized note.
            await db.prepare('DELETE FROM notes WHERE path=?').bind(entry.path).run();
          } else throw error;
        }
        continue;
      }
      const current = state.queue[0];
      const page = await listDirectory(env, current.path, current.offset, 200);
      requests++;
      if (page.serverMayHaveMore && !state.skipped.includes('[directory listing may be truncated]')) state.skipped.push('[directory listing may be truncated]');
      const entries = page.entries.filter(e => e.type === 'note');
      const old = entries.length ? await db.prepare('SELECT path,bytes,modified,etag FROM notes WHERE path IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(entries.map(e => e.path))).all<{ path: string; bytes: number; modified: string | null; etag: string | null }>() : { results: [] };
      const map = new Map(old.results.map(r => [r.path, r]));
      const unchanged: { path: string; etag: string | null }[] = [];
      for (const entry of entries) {
        const previous = map.get(entry.path);
        const same = previous && (previous.etag && entry.etag ? previous.etag === entry.etag
          : previous.bytes === entry.bytes && previous.modified && entry.lastModified && Math.floor(Date.parse(previous.modified) / 1000) === Math.floor(Date.parse(entry.lastModified) / 1000));
        if (same) unchanged.push({ path: entry.path, etag: entry.etag || previous.etag });
        else state.pending.push(entry);
      }
      if (unchanged.length) await db.prepare(`UPDATE notes SET seen_generation=?, etag=COALESCE((SELECT json_extract(value,'$.etag') FROM json_each(?) WHERE json_extract(value,'$.path')=notes.path),etag)
        WHERE path IN (SELECT json_extract(value,'$.path') FROM json_each(?))`).bind(state.generation, JSON.stringify(unchanged), JSON.stringify(unchanged)).run();
      for (const entry of page.entries) if (entry.type === 'directory') state.queue.push({ path: entry.path, offset: 0 });
      if (page.nextOffset == null) state.queue.shift(); else current.offset = page.nextOffset;
    }
    delete state.lastError;
    if (!state.queue.length && !state.pending.length) {
      state.complete = true;
      state.nextScanAfter = Date.now() + 2 * 60000;
      if (!state.skipped.includes('[directory listing may be truncated]')) await db.prepare('DELETE FROM notes WHERE seen_generation<>?').bind(state.generation).run();
      await db.prepare("INSERT OR REPLACE INTO index_meta(key,value) VALUES('last_full_scan_at',?)").bind(new Date().toISOString()).run();
    }
  } catch {
    // Retain the work item and retry later. Do not persist credentials or upstream response bodies.
    state.lastError = 'Cloud index refresh interrupted; pending work will retry.';
  }
  await db.prepare("INSERT OR REPLACE INTO index_meta(key,value) VALUES('sync_state',?)").bind(JSON.stringify(state)).run();
}
