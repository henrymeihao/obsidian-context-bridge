import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syncIndex} from '../src/sync.js';
import {syncFixture,directory} from './sync-fixture.js';

test('persisted mid-scan restart retains root proof and resumes work before individual deletion checks',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-sync-')),file=join(dir,'isolated.sqlite');let f=syncFixture(file);
  const paths=Array.from({length:12},(_,i)=>`note-${i}.md`),gets=new Map<string,number>();f.seed('gone.md');
  const fetcher=(async(url:any,init:any)=>{assert.ok(['GET','PROPFIND'].includes(init.method));if(init.method==='PROPFIND')return directory(paths);const p=decodeURIComponent(new URL(url).pathname).split('/').at(-1)!;gets.set(p,(gets.get(p)||0)+1);return p==='gone.md'?new Response(null,{status:404}):new Response('fresh',{headers:{etag:'1'}});}) as typeof fetch;
  try {
    await syncIndex(f.env,fetcher);assert.ok(f.state().pending.length>0);assert.equal(f.state().rootComplete,true);
    const generation=f.state().generation;f.sql.close();f=syncFixture(file);
    await syncIndex(f.env,fetcher);assert.equal(f.state().generation,generation);assert.equal(f.state().phase,'verify');assert.ok(f.sql.prepare("SELECT path FROM notes WHERE path='gone.md'").get());
    await syncIndex(f.env,fetcher);assert.equal(f.state().complete,true);assert.equal(f.state().deletions[0].reason,'verified_note_404');
    for(const p of paths)assert.equal(gets.get(p),1);assert.equal(gets.get('gone.md'),1);
    await syncIndex(f.env,fetcher);assert.equal(gets.get('gone.md'),1,'completed scan is idempotent');
  } finally {f.sql.close();unlinkSync(file);rmdirSync(dir);}
});

test('root failures preserve all notes and never grant sweep permission',async()=>{
  for(const status of [403,404,503]){const f=syncFixture();f.seed('keep.md');let gets=0;
    await syncIndex(f.env,async(_url,init)=>{if(init?.method==='GET')gets++;return new Response(null,{status});});
    assert.equal(f.state().complete,false);assert.equal(f.state().rootComplete,false);assert.equal(gets,0);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM notes').get()!.n,1);f.sql.close();
  }
});

test('temporary child errors and retired child 404 never authorize absence-based deletion',async()=>{
  for(const status of [503,404]){const f=syncFixture();f.seed('unseen.md');
    await syncIndex(f.env,async(url,init)=>init?.method==='PROPFIND'&&String(url).endsWith('/fixture/')?directory([],['child']):new Response(null,{status}));
    assert.equal(f.state().sweepBlocked,true);assert.ok(f.sql.prepare("SELECT path FROM notes WHERE path='unseen.md'").get());assert.equal(f.state().sweepQueue?.length||0,0);
    if(status===503){f.retryNow();await syncIndex(f.env,async()=>directory());assert.equal(f.state().complete,true);assert.equal(f.sql.prepare("SELECT value FROM index_meta WHERE key='last_full_scan_at'").get(),undefined);}
    f.sql.close();
  }
});

test('truncated directory listing is not proof of deletion',async()=>{
  const f=syncFixture();f.seed('keep.md');f.seed('unseen.md');
  await syncIndex(f.env,async()=>directory(['keep.md'],[],749));
  assert.equal(f.state().complete,true);assert.ok(f.state().skipped.includes('[directory listing may be truncated]'));assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM notes').get()!.n,2);assert.equal(f.sql.prepare("SELECT value FROM index_meta WHERE key='last_full_scan_at'").get(),undefined);f.sql.close();
});

test('file changing between pages retains old content and blocks sweep even after retry resolves',async()=>{
  const f=syncFixture();f.seed('changing.md','old evidence');f.seed('unseen.md');let reads=0;
  await syncIndex(f.env,async(_url,init)=>{if(init?.method==='PROPFIND')return new Response('<multistatus xmlns="DAV:"><response><href>/dav/fixture/changing.md</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype/><getetag>new</getetag></prop></propstat></response></multistatus>',{status:207});return new Response('x'.repeat(30001),{headers:{etag:String(++reads)}});});
  assert.equal(f.state().lastError,'source_changed');assert.equal(f.sql.prepare("SELECT content FROM notes WHERE path='changing.md'").get()!.content,'old evidence');
  f.retryNow();await syncIndex(f.env,async()=>new Response('x'.repeat(30001),{headers:{etag:'stable'}}));
  assert.equal(f.state().complete,true);assert.equal(f.sql.prepare("SELECT content FROM notes WHERE path='changing.md'").get()!.content,'x'.repeat(30001));assert.ok(f.sql.prepare("SELECT path FROM notes WHERE path='unseen.md'").get());f.sql.close();
});

test('unseen but existing notes and failed verification remain indexed; only precise 404 is cleaned once',async()=>{
  const f=syncFixture();f.seed('still-here.md');f.seed('gone.md');f.seed('unknown.md');
  await syncIndex(f.env,async()=>directory());assert.equal(f.state().phase,'verify');
  await syncIndex(f.env,async url=>String(url).endsWith('gone.md')?new Response(null,{status:404}):String(url).endsWith('unknown.md')?new Response(null,{status:403}):new Response('preserve'));
  assert.ok(f.sql.prepare("SELECT path FROM notes WHERE path='still-here.md'").get());assert.ok(f.sql.prepare("SELECT path FROM notes WHERE path='unknown.md'").get());assert.equal(f.state().complete,false);assert.deepEqual(f.state().deletions.map((d:any)=>[d.path,d.reason]),[['gone.md','verified_note_404']]);
  f.retryNow();await syncIndex(f.env,async()=>new Response('exists'));assert.equal(f.state().complete,true);assert.equal(f.state().deletions.length,1);f.sql.close();
});

test('oversized source is not deletion evidence',async()=>{
  const f=syncFixture();f.seed('large.md','old indexed evidence');
  await syncIndex(f.env,async()=>new Response('<multistatus xmlns="DAV:"><response><href>/dav/fixture/large.md</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype/><getetag>new</getetag><getcontentlength>900000</getcontentlength></prop></propstat></response></multistatus>',{status:207}));
  assert.equal(f.sql.prepare('SELECT content FROM notes').get()!.content,'old indexed evidence');assert.equal(f.state().deletions?.length||0,0);f.sql.close();
});

test('persisted verification queue without valid root proof is discarded without deletion',async()=>{
  const f=syncFixture();f.seed('keep.md');
  f.sql.prepare("INSERT INTO index_meta VALUES('sync_state',?)").run(JSON.stringify({generation:new Date().toISOString(),pruneSafe:true,scanVersion:2,rootComplete:false,phase:'verify',queue:[],pending:[],skipped:[],complete:false,sweepQueue:[{path:'keep.md'}]}));
  let requests=0;await syncIndex(f.env,async()=>{requests++;return new Response(null,{status:404});});
  assert.equal(requests,0);assert.ok(f.sql.prepare('SELECT path FROM notes').get());assert.deepEqual(f.state().queue,[{path:'',offset:0}]);f.sql.close();
});
