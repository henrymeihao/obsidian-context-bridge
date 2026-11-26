import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('workerd/D1 executes bilingual candidate SQL and reads verified memory without external traffic',async()=>{
 const {outputFiles}=await build({stdin:{contents:`
 import {recallMemory} from './src/recall.ts';
 import {captureMemory,MEMORY_SCOPE} from './src/memory.ts';
 export default {async fetch(request,env){const v=await request.json();return Response.json(v.capture?await captureMemory(env,v.capture,[MEMORY_SCOPE]):await recallMemory(env,v.recall));}};
 `,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
 const files=new Map();
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-11-01',d1Databases:{SEARCH_DB:'isolated-recall'},bindings:{ACCESS_MODE:'vault',WEBDAV_ROOT:'fixture',ALLOWED_NOTES:'',WEBDAV_USERNAME:'fixture',WEBDAV_PASSWORD:'fixture'},
 outboundService:async request=>{const url=new URL(request.url);assert.equal(url.origin,'https://dav.jianguoyun.com');
  assert.ok(decodeURIComponent(url.pathname).startsWith('/dav/fixture/Agent共享/'));
  if(request.method==='MKCOL')return new Response(null,{status:201});
  const old=files.get(url.pathname);
  if(request.method==='PUT'){assert.ok(request.headers.has('if-match')||request.headers.has('if-none-match'));files.set(url.pathname,await request.text());return new Response(null,{status:201});}
  return old?new Response(old,{headers:{etag:'fixture-etag'}}):new Response(null,{status:404});
 }}));
 try{
  const db=await mf.getD1Database('SEARCH_DB');
  await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('\n').filter(l=>!l.trimStart().startsWith('--')).join(' '));
  await db.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
  const invoke=async body=>{const r=await mf.dispatchFetch('https://fixture.invalid/',{method:'POST',body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  const context='Background: isolated client verification.\nOpen question: can another client read the evidence?';
  const captured=await invoke({capture:{memory_id:'fixture_worker_connect',topic:'client-verification',type:'working_state',summary:'Phase 3 MCP connectivity test only.',context,agent:'fixture',session_ref:'fixture',source_refs:['fixture:action'],evidence:'observed_action',stance:'confirmed',occurred_at:'2026-01-01T00:00:00Z',valid_from:'2026-01-01T00:00:00Z',authorization_ref:'fixture:authorized'}});
  assert.equal(captured.vault_synced,true);
  for(const query of ['第三阶段客户端联通性测试记忆','Phase 3 MCP connectivity test','第三阶段 MCP connectivity 验证']){
   const r=await invoke({recall:{query}});assert.equal(r.matches[0]?.id,'fixture_worker_connect');assert.equal(r.matches[0].source.startLine,19);
   assert.equal('context' in r.matches[0],false);
  }
  const expanded=await invoke({recall:{query:'connectivity',detail:'context'}});
  const hit=expanded.matches[0];assert.equal(hit.context,context);
  const rendered=[...files.values()].find(text=>text.includes('# client-verification\n'));
  assert.ok(rendered);assert.equal(rendered.split('\n').slice(hit.context_source.startLine-1,hit.context_source.endLine).join('\n'),context);
 }finally{await mf.dispose();}
});

test('workerd/D1 handles long-tail excerpts and bounded natural-query candidates with no network',async()=>{
 const {outputFiles}=await build({stdin:{contents:`
 import {recallMemory} from './src/recall.ts';
 export default {async fetch(request,env){const phases=[];const result=await recallMemory(env,await request.json(),e=>phases.push(e));return Response.json({result,phases});}};
 `,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-11-01',d1Databases:{SEARCH_DB:'bounded-recall'},bindings:{ACCESS_MODE:'vault',WEBDAV_ROOT:'fixture',ALLOWED_NOTES:''},outboundService:()=>{throw Error('No network allowed');}}));
 try{
  const db=await mf.getD1Database('SEARCH_DB');await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('\n').filter(l=>!l.trimStart().startsWith('--')).join(' '));
  await db.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
  const insert=(path,text)=>db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)').bind(path,text,text.toLowerCase(),text.length,null,null,'2026-01-01','fixture');
  for(let i=0;i<220;i+=20)await db.batch(Array.from({length:20},(_,j)=>insert(`diary/${i+j}.md`,'AI时代的旅行和学习记录\n'.repeat(500))));
  await db.batch([insert('travel/202504琥珀岛.md','琥珀岛旅行记录'),insert('knowledge/late.md','neutral\r\n'.repeat(15000)+'quartzneedle evidence\r\n'),insert('knowledge/phase3.md','Phase 3 MCP connectivity test only.')]);
  for(const [query,path] of [['找一下我2025年琥珀岛旅行的记录','travel/202504琥珀岛.md'],['quartzneedle','knowledge/late.md'],['第三阶段客户端联通性测试记忆','knowledge/phase3.md'],['Phase 3 MCP connectivity test','knowledge/phase3.md'],['第三阶段 MCP connectivity 验证','knowledge/phase3.md']]){
   const response=await mf.dispatchFetch('https://fixture.invalid/',{method:'POST',body:JSON.stringify({query,limit:5})});assert.equal(response.status,200);
   const {result,phases}=await response.json();const hit=result.matches.find(h=>h.id===path);assert.ok(hit,query);
   assert.ok(phases.find(p=>p.stage==='notes_sql').count<=65);assert.ok(phases.length<=10);assert.ok(result.matches.every(h=>h.summary.length<=1000));
   if(query==='quartzneedle'){assert.equal(hit.source.startLine,15001);assert.equal(hit.summary,'quartzneedle evidence');}
  }
 }finally{await mf.dispose();}
});
