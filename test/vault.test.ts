import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteUrl, readNote, listDirectory, parseDirectory, searchNotes } from '../src/read.js';
const env = { ACCESS_MODE: 'vault', WEBDAV_ROOT: 'obsidian', ALLOWED_NOTES: '', WEBDAV_USERNAME: 'fixture', WEBDAV_PASSWORD: 'not-a-real-password' };
const xml = (rows: { href: string; directory?: boolean; status?: number }[]) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${rows.map(r => `<d:response><d:href>${r.href}</d:href><d:propstat><d:prop><d:resourcetype>${r.directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>42</d:getcontentlength><d:getlastmodified>Wed, 11 Nov 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 ${r.status || 200} OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`;
const href = (path: string) => '/dav/obsidian/' + path.split('/').map(encodeURIComponent).join('/');
test('vault allows nested Chinese Markdown but confines paths to the configured root', () => {
  assert.equal(noteUrl(env, '示例/笔记.md'), 'https://dav.jianguoyun.com/dav/obsidian/%E7%A4%BA%E4%BE%8B/%E7%AC%94%E8%AE%B0.md');
  for (const path of ['../private.md', '.obsidian/a.md', '日记/.trash/a.md', '%2e%2e/private.md', 'a//b.md', 'a\\b.md', 'image.png']) assert.throws(() => noteUrl(env, path));
});
test('directory XML handles namespaces and excludes hidden, non-note and foreign paths', () => {
  const result = parseDirectory(env, '', xml([
    { href: '/dav/obsidian/', directory: true },
    { href: href('旅行/'), directory: true },
    { href: href('中文.md') }, { href: href('.obsidian/'), directory: true },
    { href: href('cover.png') }, { href: '/dav/another/private.md' },
    { href: 'https://evil.example/dav/obsidian/private.md' },
    { href: href('旅行/nested.md') }, { href: href('denied.md'), status: 403 },
  ]));
  assert.deepEqual(new Map(result.entries.map(e => [e.path, e.type])), new Map([['中文.md', 'note'], ['旅行', 'directory']]));
});
test('directory rejects entity declarations and malformed XML', () => {
  assert.throws(() => parseDirectory(env, '', '<!DOCTYPE a [<!ENTITY b "c">]><a/>'), /invalid directory XML/);
  assert.throws(() => parseDirectory(env, '', '<d:multistatus><oops>'), /invalid directory XML/);
});
test('PROPFIND uses depth 1 and pages the directory without requesting note bodies', async () => {
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://dav.jianguoyun.com/dav/obsidian/');
    assert.equal(init?.method, 'PROPFIND');
    assert.equal((init?.headers as Record<string,string>).Depth, '1');
    return new Response(xml(['a.md', 'b.md', 'c.md'].map(path => ({ href: href(path) }))), { status: 207 });
  };
  const page = await listDirectory(env, '', 1, 1, fake);
  assert.deepEqual(page.entries.map(e => e.path), ['b.md']);
  assert.equal(page.nextOffset, 2);
  assert.equal(page.total, 3);
});
test('recursive filename search resumes a partially consumed directory without duplicates', async () => {
  let bodyReads = 0;
  const fake: typeof fetch = async (url, init) => {
    if (init?.method !== 'PROPFIND') bodyReads++;
    const nested = String(url).endsWith('/%E6%97%85%E8%A1%8C/');
    const rows = nested ? ['旅行/游记一.md', '旅行/游记二.md'].map(p => ({ href: href(p) })) : [{ href: href('旅行/'), directory: true }, { href: href('游记三.md') }];
    return new Response(xml(rows), { status: 207 });
  };
  const matches: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await searchNotes(env, '游记', '', cursor, 1, fake);
    matches.push(...page.matches.map(e => e.path));
    cursor = page.nextCursor || undefined;
  } while (cursor);
  assert.equal(matches.length, 3);
  assert.equal(new Set(matches).size, 3);
  assert.equal(bodyReads, 0);
});
test('search request budget provides continuation instead of silently dropping later folders', async () => {
  const fake: typeof fetch = async (url) => new Response(xml(String(url).endsWith('/dav/obsidian/') ? Array.from({ length: 25 }, (_, i) => ({ href: href('folder' + i + '/'), directory: true })) : [{ href: new URL('match.md', String(url)).pathname }]), { status: 207 });
  const first = await searchNotes(env, 'match', '', undefined, 100, fake);
  assert.equal(first.directoriesRequested, 20);
  assert.ok(first.nextCursor);
  const second = await searchNotes(env, 'match', '', first.nextCursor!, 100, fake);
  assert.equal(first.matches.length + second.matches.length, 25);
  assert.equal(second.nextCursor, null);
});
test('search cursors cannot escape the selected subtree', async () => {
  const cursor = btoa(JSON.stringify({ query: 'test', basePath: 'allowed', queue: [{ path: 'private', offset: 0 }] }));
  await assert.rejects(searchNotes(env, 'test', 'allowed', cursor), /cursor is invalid/);
});
test('live search overlaps at most four directory reads and preserves breadth-first pagination', async () => {
  let active = 0, peak = 0, requests = 0;
  const fake: typeof fetch = async url => {
    requests++; active++; peak = Math.max(peak, active);
    const folder = decodeURIComponent(new URL(String(url)).pathname).split('/').at(-2)!;
    await new Promise(resolve => setTimeout(resolve, folder === 'a' ? 15 : 2));
    active--;
    const rows = folder === 'obsidian'
      ? ['a','b','c','d','e'].map(p => ({href: href(p + '/'), directory: true}))
      : Array.from({length: 3}, (_, i) => ({href: href(`${folder}/match-${i}.md`)}));
    return new Response(xml(rows), {status: 207});
  };
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const before = requests;
    const page = await searchNotes(env, 'match', '', cursor, 4, fake);
    assert.equal(page.directoriesRequested, requests - before);
    assert.equal(active, 0);
    paths.push(...page.matches.map(m => m.path)); cursor = page.nextCursor || undefined;
  } while (cursor);
  assert.equal(peak, 4);
  assert.deepEqual(paths, ['a','b','c','d','e'].flatMap(p => Array.from({length: 3}, (_, i) => `${p}/match-${i}.md`)));
});
test('a large live directory is fetched only once within a search call', async () => {
  let requests = 0;
  const fake: typeof fetch = async () => {
    requests++;
    return new Response(xml(Array.from({length: 450}, (_, i) => ({href: href(`note-${i}.md`)}))), {status: 207});
  };
  const page = await searchNotes(env, 'absent', '', undefined, 100, fake);
  assert.equal(page.nextCursor, null);
  assert.equal(page.directoriesRequested, 1);
  assert.equal(requests, 1);
});
test('concurrent directory failures are surfaced and all in-flight reads finish before return', async () => {
  let active = 0;
  const fake: typeof fetch = async url => {
    if (String(url).endsWith('/obsidian/')) return new Response(xml(['a','b','c'].map(p=>({href:href(p+'/'),directory:true}))),{status:207});
    active++;
    await new Promise(resolve=>setTimeout(resolve, String(url).endsWith('/b/') ? 10 : 1));
    active--;
    return new Response(null,{status:503});
  };
  await assert.rejects(searchNotes(env,'match','',undefined,10,fake), /WebDAV read failed \(503\)/);
  assert.equal(active,0);
});
test('long notes return bounded text chunks with continuation offsets', async () => {
  const fake: typeof fetch = async () => new Response('中'.repeat(50000));
  const first = await readNote(env, 'diary.md', fake);
  assert.equal(first.text.length, 20000);
  assert.equal(first.nextOffset, 20000);
  const last = await readNote(env, 'diary.md', fake, { offset: 40000 });
  assert.equal(last.text.length, 10000);
  assert.equal(last.nextOffset, null);
});
