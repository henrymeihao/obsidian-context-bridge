import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteUrl, readNote } from '../src/read.js';

const env = { WEBDAV_ROOT: 'ContextBridge', ALLOWED_NOTES: 'test.md,中文.md', WEBDAV_USERNAME: 'test', WEBDAV_PASSWORD: 'fixture-password' };
test('allowlist prevents traversal, hidden files, URLs and encoded bypasses', () => {
  for (const path of ['../test.md', '/test.md', '%2e%2e/test.md', 'a\\test.md', 'test.md?x', '.obsidian/config.md', 'private.md', 'https://evil.test/a.md']) {
    assert.throws(() => noteUrl(env, path));
  }
  assert.equal(noteUrl(env, '中文.md'), 'https://dav.jianguoyun.com/dav/ContextBridge/%E4%B8%AD%E6%96%87.md');
});
test('read performs only an authenticated GET and returns freshness', async () => {
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://dav.jianguoyun.com/dav/ContextBridge/test.md');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.cache, 'no-store');
    assert.equal((init?.headers as Record<string,string>).Authorization, `Basic ${btoa('test:fixture-password')}`);
    return new Response('# updated 测试', { headers: { etag: 'v2' } });
  };
  const note = await readNote(env, 'test.md', fake);
  assert.equal(note.text, '# updated 测试');
  assert.equal(note.etag, 'v2');
  assert.ok(note.fetchedAt);
});
test('forbidden notes never reach WebDAV', async () => {
  let called = false;
  await assert.rejects(readNote(env, 'private.md', async () => { called = true; return new Response('private'); }));
  assert.equal(called, false);
});
test('upstream error bodies are not disclosed', async () => {
  await assert.rejects(readNote(env, 'test.md', async () => new Response('private debug credentials', { status: 401 })), /^Error: WebDAV read failed \(401\)\.$/);
});
test('redirects are rejected without forwarding credentials to another host', async () => {
  await assert.rejects(readNote(env, 'test.md', async (_url, init) => {
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://other.example/test.md' } });
  }), /WebDAV read failed \(302\)/);
});
test('oversized bodies rejected with or without content-length', async () => {
  await assert.rejects(readNote(env, 'test.md', async () => new Response('x'.repeat(131073))), /131072 bytes/);
  await assert.rejects(readNote(env, 'test.md', async () => new Response('x', { headers: { 'content-length': '999999' } })), /131072 bytes/);
});
