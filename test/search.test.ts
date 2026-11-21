import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { compileQuery, compileGlob, findLines, searchContent, indexStatus } from '../src/search.js';
import { readNote } from '../src/read.js';
import { syncIndex, syncErrorCode } from '../src/sync.js';

function fixture(notes: { path: string; text: string }[]) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sqlite.prepare("INSERT INTO index_meta VALUES('root','obsidian')").run();
  for (const note of notes) sqlite.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)')
    .run(note.path, note.text, note.text.toLowerCase(), Buffer.byteLength(note.text), '2026-11-11T00:00:00Z', 'etag-test', '2026-11-11T01:00:00Z', 'test');
  const db = { prepare(sql: string) {
    let args: any[] = [];
    const wrapper = {
      bind(...params: any[]) { args = params; return wrapper; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async first(column?: string) { const row = sqlite.prepare(sql).get(...args) as Record<string, unknown> | undefined; return column ? row?.[column] ?? null : row ?? null; },
      async run() { return sqlite.prepare(sql).run(...args); },
    }; return wrapper;
  } } as unknown as D1Database;
  return { env: { SEARCH_DB: db, ACCESS_MODE: 'vault', WEBDAV_ROOT: 'obsidian', ALLOWED_NOTES: '', WEBDAV_USERNAME: 'fixture', WEBDAV_PASSWORD: 'fixture' }, sqlite };
}
test('content search finds Chinese text in an unrelated filename, with exact line and citation', async () => {
  const { env } = fixture([{ path: '日记/随手记.md', text: '# 随手记\n\n今天想的是产品判断力。\n另一行' }, { path: '产品判断力.md', text: '正文没有目标词' }]);
  const result = await searchContent(env, { query: '产品判断力' });
  assert.equal(result.matches.length, 1);
  const hit = result.matches[0];
  assert.equal(hit.path, '日记/随手记.md'); assert.equal(hit.lineNumber, 3); assert.equal(hit.column, 6);
  assert.equal(hit.source.citation, '【日记/随手记.md:L3】');
  assert.ok(hit.context.some(line => line.lineNumber === 4 && line.text === '另一行'));
  assert.equal(hit.indexedAt, '2026-11-11T01:00:00Z');
});
test('literal and case options match rg-style fixed-string searches', async () => {
  const { env } = fixture([{ path: 'a.md', text: 'Alpha\na.b\naxb\nalpha' }]);
  assert.equal((await searchContent(env, { query: 'ALPHA' })).matches.length, 2);
  assert.equal((await searchContent(env, { query: 'Alpha', caseSensitive: true })).matches.length, 1);
  assert.equal((await searchContent(env, { query: 'a.b' })).matches.length, 1);
  assert.equal((await searchContent(env, { query: 'a.b', regex: true })).matches.length, 2);
});
test('regex, path boundaries, Unicode paths and globs work together', async () => {
  const { env } = fixture([{ path: '😀日记/a.md', text: 'FOMO\n冲动交易' }, { path: '😀日记/子目录/b.md', text: 'fomo' }, { path: '😀日记旧/c.md', text: 'fomo' }]);
  const result = await searchContent(env, { query: 'FOMO|冲动', regex: true, path: '😀日记', glob: '**/a.md' });
  assert.deepEqual(result.matches.map(m => m.path), ['😀日记/a.md', '😀日记/a.md']);
  assert.ok(compileGlob('**/*.md')!.test('root.md'));
  assert.ok(compileGlob('日记/*.md')!.test('日记/a.md'));
  assert.ok(!compileGlob('日记/*.md')!.test('日记/子目录/a.md'));
});
test('continuation neither loses nor repeats matching lines in the same file or across files', async () => {
  const { env } = fixture([{ path: 'a.md', text: '词\n词\n词' }, { path: 'b.md', text: '词\n词' }]);
  let cursor: string | undefined;
  const results: string[] = [];
  do {
    const page = await searchContent(env, { query: '词', limit: 2, cursor });
    results.push(...page.matches.map(m => `${m.path}:${m.lineNumber}`));
    cursor = page.nextCursor || undefined;
  } while (cursor);
  assert.deepEqual(results, ['a.md:1','a.md:2','a.md:3','b.md:1','b.md:2']);
});
test('SQL metacharacters remain literal and changed queries invalidate cursors', async () => {
  const { env } = fixture([{ path: 'a.md', text: "' OR 1=1 --\nother" }]);
  const page = await searchContent(env, { query: "' OR 1=1 --", limit: 1 });
  assert.equal(page.matches.length, 1);
  await assert.rejects(searchContent(env, { query: 'other', cursor: page.nextCursor! }), /cursor is invalid/);
  await assert.rejects(searchContent({ ...env, WEBDAV_ROOT: 'another' }, { query: 'other' }), /root does not match/);
  await assert.rejects(searchContent(env, { query: 'other', path: '../outside' }), /permitted vault/);
});
test('long lines return the matching window and unsupported regex is explicit', () => {
  const hit = findLines({ path: 'a.md', content: 'x'.repeat(4000) + '目标' + 'y'.repeat(4000), indexed_at: 'now', etag: null, modified: null }, { query: '目标' })[0];
  assert.ok(hit.text.includes('目标')); assert.equal(hit.column, 4001); assert.equal(hit.lineTruncated, true);
  assert.throws(() => compileQuery('(unclosed', true), /invalid or unsupported/);
  assert.throws(() => compileQuery('a\nb'), /single-line/);
});
test('live line-range reads normalize CRLF and return attributable inclusive ranges', async () => {
  const { env } = fixture([]);
  const note = await readNote(env, 'a.md', async () => new Response('标题\r\n第一行\r\n原话内容\r\n最后一行\r\n'), { startLine: 2, endLine: 3 });
  assert.equal(note.text, '第一行\n原话内容');
  assert.equal(note.source.citation, '【a.md:L2-L3】');
  assert.equal(note.startLine, 2); assert.equal(note.endLine, 3); assert.equal(note.nextOffset, null);
});
test('index status exposes source freshness and note count', async () => {
  const { env } = fixture([{ path: 'a.md', text: 'hello' }]);
  const status = await indexStatus(env) as any;
  assert.equal(status.notes, 1); assert.equal(status.root, 'obsidian'); assert.equal(status.lastFullScanAt, null);
});
test('cloud refresh keeps unchanged content, adopts metadata and deletes notes only after a complete scan', async () => {
  const { env, sqlite } = fixture([{ path: 'a.md', text: 'hello' }, { path: 'deleted.md', text: 'gone' }]);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; if(init?.method==='GET')return new Response(null,{status:404});
    assert.equal(init?.method, 'PROPFIND');
    return new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/obsidian/a.md</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype/><d:getcontentlength>5</d:getcontentlength><d:getetag>etag-test</d:getetag><d:getlastmodified>Wed, 11 Nov 2026 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 });
  };
  try { await syncIndex(env); await syncIndex(env); } finally { globalThis.fetch = original; }
  assert.equal(calls, 2);
  assert.equal((sqlite.prepare('SELECT COUNT(*) n FROM notes').get() as any).n, 1);
  assert.equal((sqlite.prepare("SELECT content FROM notes WHERE path='a.md'").get() as any).content, 'hello');
  const status = await indexStatus(env) as any;
  assert.equal(status.sync.complete, true); assert.ok(status.lastFullScanAt);
});
test('cloud refresh reindexes changed text and preserves old records when listing fails', async () => {
  const { env, sqlite } = fixture([{ path: 'a.md', text: 'old' }]);
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => init?.method === 'PROPFIND'
    ? new Response('<multistatus xmlns="DAV:"><response><href>/dav/obsidian/a.md</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype/><getcontentlength>10</getcontentlength><getetag>etag-new</getetag><getlastmodified>Thu, 12 Nov 2026 00:00:00 GMT</getlastmodified></prop></propstat></response></multistatus>', { status: 207 })
    : new Response('new 产品判断力', { headers: { etag: 'etag-new', 'last-modified': 'Thu, 12 Nov 2026 00:00:00 GMT' } });
  try { await syncIndex(env); } finally { globalThis.fetch = original; }
  assert.equal((sqlite.prepare("SELECT content FROM notes WHERE path='a.md'").get() as any).content, 'new 产品判断力');
  sqlite.prepare("DELETE FROM index_meta WHERE key='sync_state'").run();
  sqlite.prepare("DELETE FROM index_meta WHERE key='sync_lock'").run();
  globalThis.fetch = async () => new Response('temporarily unavailable', { status: 503 });
  try { await syncIndex(env); } finally { globalThis.fetch = original; }
  assert.equal((sqlite.prepare('SELECT COUNT(*) n FROM notes').get() as any).n, 1);
  const state = (await indexStatus(env) as any).sync;
  assert.equal(state.complete, false); assert.ok(state.lastError);
});

test('poison item is deferred with safe diagnostics; healthy work checkpoints and resumes',async()=>{
  const {env,sqlite}=fixture([{path:'keep.md',text:'preserved'}]);
  const entry=(path:string)=>({path,type:'note',bytes:5,lastModified:null});
  const state={generation:new Date().toISOString(),pruneSafe:true,scanVersion:2,rootComplete:true,queue:[],pending:[entry('bad.md'),entry('good.md')],complete:false,skipped:[]};
  sqlite.prepare("INSERT INTO index_meta VALUES('sync_state',?)").run(JSON.stringify(state));
  let badCalls=0,goodCalls=0;
  const fetcher=(async(url:any)=>{
    if(String(url).endsWith('bad.md')){badCalls++;return new Response('credential PRIVATE_NOTE_SHOULD_NOT_PERSIST',{status:429});}
    goodCalls++;const saved=JSON.parse(sqlite.prepare("SELECT value FROM index_meta WHERE key='sync_state'").get()!.value as string);
    assert.equal(saved.deferred.length,1,'failed work was checkpointed before next request');
    return new Response('fresh');
  }) as typeof fetch;
  await syncIndex(env,fetcher);
  let status=await indexStatus(env) as any;assert.equal(status.sync.complete,false);assert.equal(status.sync.lastError,'webdav_429');
  assert.equal(status.notes,2);assert.equal(badCalls,1);assert.equal(goodCalls,1);assert.ok(status.sync.checkpointAt);assert.ok(status.sync.lastProgressAt);
  assert.ok(!JSON.stringify(status).includes('PRIVATE_NOTE'));
  await syncIndex(env,fetcher);assert.equal(badCalls,1,'respect backoff');assert.equal(goodCalls,1,'do not restart completed work');
  const saved=status.sync;saved.retries['bad.md'].after=0;
  sqlite.prepare("UPDATE index_meta SET value=? WHERE key='sync_state'").run(JSON.stringify(saved));
  await syncIndex(env,async()=>new Response('fixed'));
  status=await indexStatus(env) as any;assert.equal(status.sync.complete,true);assert.equal(status.lastFullScanAt,null);assert.equal(status.sync.lastError,undefined);
  assert.equal(sqlite.prepare("SELECT content FROM notes WHERE path='bad.md'").get()!.content,'fixed');
  assert.equal(syncErrorCode(new Error('secret URL username private body')),'storage_or_network');
  assert.equal(syncErrorCode(new DOMException('private url','TimeoutError')),'timeout');
});

test('index root mismatch is observable without resetting index; expired lease can resume',async()=>{
  const {env,sqlite}=fixture([{path:'a.md',text:'preserved'}]);
  await syncIndex({...env,WEBDAV_ROOT:'other'},async()=>{throw new Error('must not fetch');});
  assert.equal((await indexStatus(env)).diagnostic,'root_mismatch');
  assert.equal(sqlite.prepare('SELECT content FROM notes').get()!.content,'preserved');
  sqlite.prepare("INSERT INTO index_meta VALUES('sync_lock',?)").run(String(Date.now()-1));
  await syncIndex(env,async()=>new Response('<multistatus/>'));
  assert.equal((await indexStatus(env)).diagnostic,null);
});

test('deleted queued non-root directory does not stall remaining scan; root 404 preserves index',async()=>{
  const {env,sqlite}=fixture([{path:'keep.md',text:'preserved'}]);
  const state={generation:'test-generation',queue:[{path:'renamed-folder',offset:0},{path:'',offset:0}],pending:[],complete:false,skipped:[]};
  sqlite.prepare("INSERT INTO index_meta VALUES('sync_state',?)").run(JSON.stringify(state));
  await syncIndex(env,async()=>new Response(null,{status:404}));
  const status=await indexStatus(env) as any;
  assert.equal(status.sync.retiredDirectories,1);assert.equal(status.sync.deferred.length,1);
  assert.equal(status.sync.deferred[0].path,'');assert.equal(status.sync.complete,false);
  assert.equal(sqlite.prepare('SELECT content FROM notes').get()!.content,'preserved');
});

test('request-budget yield checkpoints notes and next invocation avoids re-fetching completed work',async()=>{
  const {env,sqlite}=fixture([]);
  sqlite.prepare("INSERT INTO index_meta VALUES('sync_state',?)").run(JSON.stringify({generation:new Date().toISOString(),pruneSafe:true,scanVersion:2,rootComplete:true,queue:[],pending:Array.from({length:12},(_,i)=>({path:`note-${i}.md`,type:'note',bytes:5,lastModified:null})),complete:false,skipped:[]}));
  const seen=new Set<string>();const fetcher=(async(url:any)=>{assert.ok(!seen.has(String(url)));seen.add(String(url));return new Response('hello');}) as typeof fetch;
  await syncIndex(env,fetcher);assert.equal(seen.size,10);assert.equal((await indexStatus(env) as any).sync.pending.length,2);
  await syncIndex(env,fetcher);assert.equal(seen.size,12);assert.equal((await indexStatus(env) as any).sync.complete,true);
});

test('stale or untrusted scan cannot prune until a new complete root traversal',async()=>{
  for(const saved of [
    {generation:new Date(Date.now()-7*86400000).toISOString(),pruneSafe:true},
    {generation:new Date().toISOString()},
    {generation:'invalid',pruneSafe:true},
    {generation:new Date(Date.now()+86400000).toISOString(),pruneSafe:true},
  ]) {
    const {env,sqlite}=fixture([{path:'keep.md',text:'preserved'},{path:'gone.md',text:'old'}]);
    const previous='2026-01-01T00:00:00Z';
    sqlite.prepare("INSERT INTO index_meta VALUES('last_full_scan_at',?)").run(previous);
    sqlite.prepare("INSERT INTO index_meta VALUES('sync_state',?)").run(JSON.stringify({...saved,queue:Array.from({length:33},(_,i)=>({path:`removed-${i}`,offset:0})),pending:[],complete:false,skipped:[]}));
    for(let i=0;i<4;i++)await syncIndex(env,async()=>new Response(null,{status:404}));
    const restarted=await indexStatus(env) as any;
    assert.equal(restarted.notes,2,'old progress is not proof that unseen files were deleted');
    assert.equal(restarted.lastFullScanAt,previous,'discarded traversal cannot claim freshness');
    assert.equal(restarted.sync.complete,false);
    assert.deepEqual(restarted.sync.queue,[{path:'',offset:0}]);
    assert.equal(restarted.sync.rescanReason,'expired_or_untrusted_generation');
    await syncIndex(env,async()=>new Response('<multistatus xmlns="DAV:"><response><href>/dav/obsidian/keep.md</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype/><getetag>etag-test</getetag><getcontentlength>9</getcontentlength></prop></propstat></response></multistatus>',{status:207}));
    assert.ok(sqlite.prepare("SELECT path FROM notes WHERE path='gone.md'").get(),'listing absence alone never deletes');
    await syncIndex(env,async()=>new Response(null,{status:404}));
    const fresh=await indexStatus(env) as any;
    assert.equal(fresh.sync.complete,true);assert.notEqual(fresh.lastFullScanAt,previous);
    assert.equal(sqlite.prepare("SELECT content FROM notes WHERE path='keep.md'").get()!.content,'preserved');
    assert.equal(sqlite.prepare("SELECT path FROM notes WHERE path='gone.md'").get(),undefined);
  }
});
