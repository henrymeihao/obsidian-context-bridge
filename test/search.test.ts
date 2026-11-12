import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { compileQuery, compileGlob, findLines, searchContent, indexStatus } from '../src/search.js';
import { readNote } from '../src/read.js';
import { syncIndex } from '../src/sync.js';

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
    calls++; assert.equal(init?.method, 'PROPFIND');
    return new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/obsidian/a.md</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype/><d:getcontentlength>5</d:getcontentlength><d:getetag>etag-test</d:getetag><d:getlastmodified>Wed, 11 Nov 2026 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 });
  };
  try { await syncIndex(env); } finally { globalThis.fetch = original; }
  assert.equal(calls, 1);
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
