import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workerdFixture} from './workerd-fixture.mjs';

function mockVault(){
  const files=new Map(),failures=new Map(),calls=[];
  let queueing=false;
  const set=(path,text,version='1')=>files.set(path,{text,version,modified:version==='1'?'Tue, 01 Jan 2030 00:00:00 GMT':'Wed, 02 Jan 2030 00:00:00 GMT'});
  const outbound=async request=>{
    const path=decodeURIComponent(new URL(request.url).pathname.slice('/dav/fixture/'.length));
    const method=request.method;
    const status=failures.get(method+':'+path)||(queueing?503:0);
    calls.push({method,path,status});
    if(status)return new Response(null,{status});
    if(method==='MKCOL')return new Response(null,{status:201});
    if(method==='PROPFIND'){
      const children=new Set();
      for(const name of files.keys())if(name.startsWith(path)){
        const rest=name.slice(path.length),slash=rest.indexOf('/');
        children.add(slash<0?name:path+rest.slice(0,slash+1));
      }
      const xml=[...children].sort().map(name=>{
        const file=files.get(name),dir=name.endsWith('/');
        return `<response><href>/dav/fixture/${encodeURI(name)}</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype>${dir?'<collection/>':''}</resourcetype><getetag>${file?.version||'1'}</getetag><getcontentlength>${file?Buffer.byteLength(file.text):0}</getcontentlength><getlastmodified>${file?.modified||''}</getlastmodified></prop></propstat></response>`;
      }).join('');
      return new Response(`<multistatus xmlns="DAV:">${xml}</multistatus>`,{status:207});
    }
    const old=files.get(path);
    if(method==='PUT'){
      assert.ok(request.headers.has('if-match')||request.headers.has('if-none-match'));
      if(request.headers.get('if-none-match')==='*'&&old)return new Response(null,{status:412});
      if(request.headers.has('if-match')&&request.headers.get('if-match')!==old?.version)return new Response(null,{status:412});
      set(path,await request.text(),String(Number(old?.version||0)+1));
      return new Response(null,{status:201});
    }
    assert.equal(method,'GET');
    return old?new Response(old.text,{headers:{etag:old.version,'last-modified':old.modified}}):new Response(null,{status:404});
  };
  return {files,failures,calls,set,outbound,set queueing(value){queueing=value;}};
}
const memory=(id,topic)=>({memory_id:id,topic,type:'exploration',summary:'Synthetic '+id,agent:'fixture',session_ref:'isolated-reliability',source_refs:['fixture:evidence'],evidence:'user_statement',stance:'considering',occurred_at:'2026-01-01T00:00:00Z',valid_from:'2026-01-01T00:00:00Z',authorization_ref:'fixture:authorized'});
const activity=id=>({event_id:id,project:'fixture-project',project_name:'Fixture',task_id:'fixture-task',task_name:'Fixture task',agent:'fixture',session_ref:'isolated-reliability',occurred_at:'2026-01-01T00:00:00Z',kind:'progress',evidence:'observed_action',status:'in_progress',summary:'Synthetic '+id,sources:['fixture:evidence']});
const meta=async(f,key)=>f.db.prepare('SELECT value FROM index_meta WHERE key=?').bind(key).first('value');
const state=async f=>JSON.parse(await meta(f,'sync_state'));
async function expireTimers(f){
  const s=await state(f);s.nextScanAfter=0;
  for(const retry of Object.values(s.retries||{}))retry.after=0;
  for(const retry of s.sweepQueue||[])retry.after=0;
  await f.db.prepare("UPDATE index_meta SET value=? WHERE key='sync_state'").bind(JSON.stringify(s)).run();
}
async function finishScan(f){
  for(let i=0;i<100;i++){
    assert.equal((await f.invoke('/cron')).rejected,0);
    if((await state(f)).complete)return;
  }
  assert.fail('scan did not finish within bounded cron invocations');
}
async function indexed(f,query='fixture-test'){
  const paths=[];let cursor;
  do{
    const result=await f.tool('search_context',{mode:'filename_indexed',query,limit:13,...(cursor?{cursor}:{})});
    assert.equal(result.directoriesRequested,0);paths.push(...result.matches.map(m=>m.path));cursor=result.nextCursor;
    assert.ok(paths.length<1000);
  }while(cursor);
  assert.equal(new Set(paths).size,paths.length);return paths;
}

for(const method of ['GET','PUT'])test(`Memory topic ${method}503 remains observable through healthy rounds and recovers on rotation`,async t=>{
  const vault=mockVault(),f=await workerdFixture(vault.outbound);
  try{
    for(const topic of ['topic-a','topic-b','topic-c','topic-d','topic-e','topic-f'])await f.invoke('/capture',memory('fixture_memory_'+topic,topic));
    const path='Agent共享/个人记忆/主题/topic-a.md',before=vault.files.get(path).text;
    vault.failures.set(method+':'+path,503);
    await f.invoke('/capture',{...memory('fixture_memory_revision','topic-a'),supersedes:'fixture_memory_topic-a',summary:'Updated synthetic summary'});
    await f.invoke('/cron');
    const failed=await f.db.prepare("SELECT content,sync_error FROM memory_views WHERE topic='topic-a'").first();
    const error=await meta(f,'memory_last_error:fixture');
    await f.invoke('/cron');
    const errorAfterHealthyRound=await meta(f,'memory_last_error:fixture');
    const recall=await f.tool('recall_memory',{query:'synthetic',topics:['topic-a']});
    assert.ok(recall.view_conflicts.some(v=>v.topic==='topic-a'&&v.sync_error),'MCP must expose topic failure');
    vault.failures.delete(method+':'+path);
    await f.invoke('/cron');
    const recovered=await f.db.prepare("SELECT content,sync_error FROM memory_views WHERE topic='topic-a'").first();
    t.diagnostic(JSON.stringify({scenario:'memory'+method+'503',before:{error:null},failed:{error:failed.sync_error,background:error},healthyRound:{background:errorAfterHealthyRound},recovered:{error:recovered.sync_error,background:await meta(f,'memory_last_error:fixture')}}));
    assert.equal(failed.content,before);assert.notEqual(recovered.content,before);
    assert.match(recovered.content,/Updated synthetic summary/);assert.equal(recovered.sync_error,null);
    assert.equal(await meta(f,'memory_last_error:fixture'),null);
    assert.ok(failed.sync_error,'failed topic must have a persisted error');
    assert.ok(error,'scheduled failure must stay visible');
    assert.ok(errorAfterHealthyRound,'healthy topics cannot clear another topic failure');
  }finally{await f.dispose();}
});

test('scheduled Memory conflict stays visible and never overwrites manual edits',async()=>{
  const vault=mockVault(),f=await workerdFixture(vault.outbound);
  try{
    await f.invoke('/capture',memory('fixture_manual_memory','manual-topic'));
    const path='Agent共享/个人记忆/主题/manual-topic.md';
    vault.set(path,'Manual content must survive','42');
    const puts=vault.calls.filter(c=>c.method==='PUT'&&c.path===path).length;
    for(let i=0;i<2;i++)await f.invoke('/cron');
    assert.equal(vault.files.get(path).text,'Manual content must survive');
    assert.equal(vault.calls.filter(c=>c.method==='PUT'&&c.path===path).length,puts);
    assert.equal(await f.db.prepare("SELECT sync_error FROM memory_views WHERE topic='manual-topic'").first('sync_error'),'manual_view_conflict');
    assert.ok(await meta(f,'memory_last_error:fixture'));
  }finally{await f.dispose();}
});

for(const blocked of [1,5])test(`Activity queue: ${blocked} persistent head failures do not starve later events`,async t=>{
  const vault=mockVault(),f=await workerdFixture(vault.outbound);
  try{
    vault.queueing=true;
    for(let i=0;i<8;i++){
      const id='fixture_activity_'+i;
      assert.equal((await f.invoke('/activity',activity(id))).vault_synced,false);
      // Deterministic enqueue ordering only; payload and sync status come from appendActivity.
      await f.db.prepare('UPDATE shared_activity SET recorded_at=? WHERE event_id=?').bind(`2026-01-01T00:00:0${i}Z`,id).run();
    }
    vault.queueing=false;
    for(let i=0;i<blocked;i++)vault.failures.set('GET:Agent共享/活动记录/fixture_activity_'+i+'.md',503);
    for(let i=0;i<4;i++)await f.invoke('/cron');
    const stalled=(await f.db.prepare('SELECT event_id,vault_synced FROM shared_activity ORDER BY event_id').all()).results;
    const error=await meta(f,'activity_last_error:fixture');
    vault.failures.clear();
    for(let i=0;i<3;i++)await f.invoke('/cron');
    const recovered=(await f.db.prepare('SELECT event_id,vault_synced FROM shared_activity ORDER BY event_id').all()).results;
    const puts=vault.calls.filter(c=>c.method==='PUT').length;
    await f.invoke('/cron');assert.equal(vault.calls.filter(c=>c.method==='PUT').length,puts);
    t.diagnostic(JSON.stringify({scenario:'activity'+blocked,before:Array(8).fill(0),during:stalled.map(r=>r.vault_synced),after:recovered.map(r=>r.vault_synced),errorVisible:!!error}));
    assert.ok(recovered.every(r=>r.vault_synced===1));assert.equal(await meta(f,'activity_last_error:fixture'),null);
    assert.ok(error);assert.ok(stalled.slice(0,blocked).every(r=>r.vault_synced===0));
    assert.ok(stalled.slice(blocked).every(r=>r.vault_synced===1),'healthy tail must progress while head remains unavailable');
  }finally{await f.dispose();}
});

test('real D1 checkpoint outage resumes across workerd restart; multipage index lifecycle preserves unrelated rows',async t=>{
  const vault=mockVault(),dir=mkdtempSync(join(tmpdir(),'ocb-reliability-'));
  let f=await workerdFixture(vault.outbound,{persistPath:dir});
  try{
    vault.set('unrelated/sentinel.md','Untouched evidence');
    for(let i=0;i<205;i++)vault.set(`fixture-test/note-${String(i).padStart(3,'0')}.md`,'Original '+i);
    const interrupted=await f.invoke('/cron',{failCheckpointAt:6});
    assert.equal(interrupted.rejected,1);
    const checkpoint=await state(f),generation=checkpoint.generation;
    assert.equal(checkpoint.queue.find(q=>q.path==='fixture-test')?.offset,200);
    await f.dispose();f=await workerdFixture(vault.outbound,{persistPath:dir});
    await finishScan(f);assert.equal((await state(f)).generation,generation);
    assert.equal((await indexed(f)).length,205);
    const before=(await f.db.prepare("SELECT path,content,etag,modified FROM notes WHERE path IN ('fixture-test/note-000.md','unrelated/sentinel.md') ORDER BY path").all()).results;
    const sentinel=before.find(r=>r.path==='unrelated/sentinel.md');
    vault.set('fixture-test/note-000.md','Modified evidence','2');
    vault.set('fixture-test/added.md','New evidence');
    vault.files.set('fixture-test/renamed.md',vault.files.get('fixture-test/note-001.md'));vault.files.delete('fixture-test/note-001.md');
    vault.files.delete('fixture-test/note-002.md');
    vault.failures.set('PROPFIND:fixture-test/',503);
    await expireTimers(f);await f.invoke('/cron');
    const failed=await state(f);
    assert.ok(failed.deferred.some(x=>x.path==='fixture-test'));assert.equal(failed.retries['fixture-test'].code,'webdav_503');
    assert.equal((await indexed(f)).length,205);
    const retained=await f.db.prepare("SELECT content FROM notes WHERE path='fixture-test/note-000.md'").first('content');assert.equal(retained,'Original 0');
    const failedRequests=vault.calls.filter(c=>c.method==='PROPFIND'&&c.path==='fixture-test/'&&c.status===503).length;
    await f.invoke('/cron');assert.equal(vault.calls.filter(c=>c.method==='PROPFIND'&&c.path==='fixture-test/'&&c.status===503).length,failedRequests,'backoff must suppress early retry');
    vault.failures.clear();await expireTimers(f);await finishScan(f);
    assert.equal((await state(f)).generation,failed.generation);assert.equal((await state(f)).sweepBlocked,true);
    assert.ok((await indexed(f)).includes('fixture-test/note-002.md'),'failed generation cannot infer deletion');
    await expireTimers(f);await finishScan(f);
    const after=(await f.db.prepare("SELECT path,content,etag,modified FROM notes WHERE path IN ('fixture-test/note-000.md','unrelated/sentinel.md') ORDER BY path").all()).results;
    assert.deepEqual(after.find(r=>r.path===sentinel.path),sentinel);
    assert.equal(after[0].etag,'2');assert.notEqual(after[0].modified,before[0].modified);
    const expected=[...vault.files.keys()].filter(p=>p.startsWith('fixture-test/')).sort();
    assert.deepEqual(await indexed(f),expected);
    for(const p of ['fixture-test/note-001.md','fixture-test/note-002.md'])assert.ok((await state(f)).deletions.some(d=>d.path===p&&d.reason==='verified_note_404'));
    const allBefore=(await f.db.prepare('SELECT * FROM notes ORDER BY path').all()).results;
    await f.invoke('/cron');assert.deepEqual((await f.db.prepare('SELECT * FROM notes ORDER BY path').all()).results,allBefore);
    for(const path of [...vault.files.keys()])if(path.startsWith('fixture-test/'))vault.files.delete(path);
    await expireTimers(f);await finishScan(f);
    assert.deepEqual(await indexed(f),[]);
    assert.deepEqual((await f.db.prepare('SELECT path,content,etag,modified FROM notes').all()).results,[sentinel]);
    t.diagnostic(JSON.stringify({scenario:'index-lifecycle',before,after,totalAfterChanges:expected.length,cleanupRemaining:[sentinel.path],checkpointOffset:200,restartSameGeneration:true}));
  }finally{await f.dispose();rmSync(dir,{recursive:true});assert.equal(existsSync(dir),false);}
});
