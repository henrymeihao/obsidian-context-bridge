import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function fixture() {
  const sql=new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  sql.exec(readFileSync(new URL('../migrations/0001_shared_activity.sql',import.meta.url),'utf8'));
  const db={prepare(query:string){let args:any[]=[];const self={bind(...values:any[]){args=values;return self;},async run(){sql.prepare(query).run(...args);return {success:true};},async first(column?:string){const row=sql.prepare(query).get(...args) as any;return column?row?.[column]??null:row??null;},async all(){return {results:sql.prepare(query).all(...args),success:true};}};return self;}};
  const env={ACCESS_MODE:'vault',WEBDAV_ROOT:'fixture',ALLOWED_NOTES:'',WEBDAV_USERNAME:'fixture',WEBDAV_PASSWORD:'fixture',SEARCH_DB:db as unknown as D1Database};
  const files=new Map<string,{text:string;version:number}>();let fail=false,puts=0;
  const fetcher=(async (url:any,init:RequestInit={})=>{
    const u=new URL(url);assert.equal(u.origin,'https://dav.jianguoyun.com');
    const path=decodeURIComponent(u.pathname).replace('/dav/fixture/','');
    assert.ok(path.startsWith('Agent共享/'));
    if(fail)return new Response(null,{status:503});
    if(init.method==='MKCOL')return new Response(null,{status:201});
    const old=files.get(path),headers=new Headers(init.headers);
    if(init.method==='PUT'){
      if(headers.get('If-None-Match')==='*'&&old)return new Response(null,{status:412});
      if(headers.has('If-Match')&&headers.get('If-Match')!==String(old?.version))return new Response(null,{status:412});
      assert.ok(headers.has('If-Match')||headers.has('If-None-Match'));
      files.set(path,{text:String(init.body),version:(old?.version||0)+1});puts++;return new Response(null,{status:201});
    }
    return old?new Response(old.text,{headers:{etag:String(old.version)}}):new Response(null,{status:404});
  }) as typeof fetch;
  return {env,files,fetcher,sql,get puts(){return puts;},set fail(v:boolean){fail=v;}};
}
