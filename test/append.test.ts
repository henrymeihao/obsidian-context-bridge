import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendDiet } from '../src/append.js';
const env = { ACCESS_MODE:'vault', WEBDAV_ROOT:'obsidian', ALLOWED_NOTES:'', WEBDAV_USERNAME:'test', WEBDAV_PASSWORD:'test' };
const input = { text:'早餐：鸡蛋', date:'2026-11-12', record_id:'record_123456' };
function fixture(initial: Uint8Array, conflict = false, etag = true) {
 let body = initial, version = 1, puts = 0;
 const fetcher = (async (_url: any, init: RequestInit) => {
  assert.ok(String(_url).endsWith(encodeURIComponent('饮食记录.md')));
  if(init.method === 'PUT') {
   puts++;
   if(conflict) { conflict = false; body = new Uint8Array(Buffer.concat([body, Buffer.from('电脑追加\r\n')])); version++; return new Response(null,{status:412}); }
   assert.equal((init.headers as any)['If-Match'], String(version));
   body = new Uint8Array(init.body as Uint8Array); version++;
   return new Response(null,{status:204});
  }
  return new Response(new Uint8Array(body), {headers:etag ? {etag:String(version)} : {}});
 }) as typeof fetch;
 return { fetcher, get body(){ return body; }, get puts(){ return puts; } };
}
test('append preserves original BOM/CRLF bytes; same request is idempotent; changed payload rejected', async()=>{
 const original = new Uint8Array(Buffer.from('\ufeff# 旧记录\r\n原文\r\n'));
 const f=fixture(original);
 assert.equal((await appendDiet(env,input,f.fetcher)).status,'appended');
 assert.deepEqual(f.body.slice(0,original.length),original);
 assert.equal((await appendDiet(env,input,f.fetcher)).status,'already_recorded');
 assert.equal(f.puts,1);
 await assert.rejects(appendDiet(env,{...input,text:'另一个内容'},f.fetcher),/already used/);
});
test('412 retry preserves concurrent desktop update',async()=>{
 const f=fixture(new Uint8Array(Buffer.from('旧内容\r\n')),true);
 await appendDiet(env,input,f.fetcher);
 assert.ok(Buffer.from(f.body).toString().startsWith('旧内容\r\n电脑追加\r\n'));
 assert.equal(f.puts,2);
});
test('missing ETag refuses all writes; invalid date refuses all requests',async()=>{
 const f=fixture(new Uint8Array(),false,false);
 await assert.rejects(appendDiet(env,input,f.fetcher),/ETag/);
 assert.equal(f.puts,0);
 await assert.rejects(appendDiet(env,{...input,date:'2026-02-30'},f.fetcher),/date/);
});
