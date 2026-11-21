import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
if(!args.includes('--rollback-bundle'))throw new Error('Required: --rollback-bundle LOCAL_OLD_WORKER_BUNDLE');
const rollbackBundle=resolve(get('--rollback-bundle')).replaceAll('\\','/');
const root=process.cwd().replaceAll('\\','/'),origin='https://preflight.example',out=root+'/work/release-rehearsal';
await mkdir(out,{recursive:true});
const wrapper=async(input,name)=>{
 const code=`import worker from ${JSON.stringify(input)}; export default {async fetch(req,env,ctx){if(new URL(req.url).pathname==='/__local_cron'){const jobs=[];await worker.scheduled({},env,{waitUntil(p){jobs.push(p)}});await Promise.all(jobs);return Response.json({done:true});}return worker.fetch(req,env,ctx);}};`;
 await build({stdin:{contents:code,resolveDir:root,sourcefile:'preflight-only-wrapper.js'},bundle:true,format:'esm',platform:'neutral',external:['node:*','cloudflare:*'],outfile:out+'/'+name+'.js'});
 return out+'/'+name+'.js';
};
const current=await wrapper(root+'/work/preflight-current-bundle/index.js','v3');
const prior=await wrapper(rollbackBundle,'v2');
const files=new Map([['knowledge/history.md',{text:'# Historical fixture\n职业转型需要先验证兴趣。',v:1}],['饮食记录.md',{text:'# Fixture meals\n',v:1}]]);
let outage=false,external=0,puts=0;const calls=[];
const outbound=async req=>{
 external++;const u=new URL(req.url);assert.equal(u.origin,'https://dav.jianguoyun.com');assert.ok(u.pathname.startsWith('/dav/fixture/'));
 const path=decodeURIComponent(u.pathname.slice('/dav/fixture/'.length));calls.push({method:req.method,path});
 if(outage)return new Response(null,{status:503});
 if(req.method==='MKCOL')return new Response(null,{status:201});
 if(req.method==='PROPFIND'){
  if(path==='removed/')return new Response(null,{status:404});
  const listed=path===''?['knowledge/','饮食记录.md']:path==='knowledge/'?['knowledge/history.md']:[];
  return new Response(`<multistatus xmlns="DAV:">${listed.map(p=>`<response><href>/dav/fixture/${encodeURI(p)}</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype>${p.endsWith('/')?'<collection/>':''}</resourcetype><getetag>${files.get(p)?.v||1}</getetag><getcontentlength>${files.has(p)?Buffer.byteLength(files.get(p).text):0}</getcontentlength></prop></propstat></response>`).join('')}</multistatus>`,{status:207});
 }
 const old=files.get(path);
 if(req.method==='PUT'){
  if(req.headers.get('if-none-match')==='*'&&old)return new Response(null,{status:412});
  if(req.headers.has('if-match')&&req.headers.get('if-match')!==String(old?.v))return new Response(null,{status:412});
  assert.ok(req.headers.has('if-match')||req.headers.has('if-none-match'));files.set(path,{text:await req.text(),v:(old?.v||0)+1});puts++;return new Response(null,{status:201});
 }
 return old?new Response(old.text,{headers:{etag:String(old.v)}}):new Response(null,{status:404});
};
const key=randomBytes(32).toString('base64url');
const opts=scriptPath=>convertV4MiniflareOptions({modules:true,scriptPath,compatibilityDate:'2026-11-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],d1Databases:{SEARCH_DB:'preflight-isolated'},kvNamespaces:['OAUTH_KV'],bindings:{PUBLIC_ORIGIN:origin,ACCESS_MODE:'vault',WEBDAV_ROOT:'fixture',ALLOWED_NOTES:'',WEBDAV_USERNAME:'fixture-only',WEBDAV_PASSWORD:'fixture-only',OWNER_KEY_SHA256:createHash('sha256').update(key).digest('hex')},outboundService:outbound});
const mf=new Miniflare(opts(current));const report=[];
const check=(name,details={})=>{report.push({name,passed:true,...details});console.log(JSON.stringify(report.at(-1)));};
const request=(p,init={})=>mf.dispatchFetch(origin+p,{...init,redirect:'manual'});
try{
 let db=await mf.getD1Database('SEARCH_DB');
 const schema=(await readFile('schema.sql','utf8')).split('-- Additive only;')[0];
 await db.exec(schema.split('\n').filter(l=>!l.trim().startsWith('--')).join(' '));
 await db.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
 await db.prepare("INSERT INTO index_meta VALUES('sync_state',?)").bind(JSON.stringify({generation:new Date().toISOString(),pruneSafe:true,scanVersion:2,queue:[{path:'removed',offset:0},{path:'',offset:0}],pending:[],complete:false,skipped:[]})).run();
 const migration=(await readFile('migrations/0002_personal_memory.sql','utf8')).split('\n').filter(l=>!l.trim().startsWith('--')).join(' ');
 await db.exec(migration);await db.exec(migration);check('additive migration applied twice in workerd D1');
 const authorize=async scope=>{
  const registered=await request('/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Isolated release rehearsal',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});assert.equal(registered.status,201);
  const client=await registered.json(),verifier=randomBytes(48).toString('base64url');
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.example/callback',response_type:'code',scope,state:'rehearsal',resource:origin+'/mcp',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  const page=await request('/authorize?'+params),html=await page.text();assert.equal(page.status,200);
  if(scope.includes('context:write:memory'))assert.ok(html.includes('个人记忆'));
  const handle=html.match(/name="handle" value="([^"]+)"/)[1],cookie=page.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const approved=await request('/authorize',{method:'POST',headers:{origin,cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,owner_key:key,decision:'approve'})});assert.equal(approved.status,302);
  const cb=new URL(approved.headers.get('location'));
  const token=await request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:cb.searchParams.get('code'),code_verifier:verifier,redirect_uri:'https://client.example/callback',resource:origin+'/mcp'})});assert.equal(token.status,200);return (await token.json()).access_token;
 };
 const rpc=async(token,method,params)=>{const r=await request('/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);return (await r.json()).result;};
 const tool=async(token,name,args)=>{const r=await rpc(token,'tools/call',{name,arguments:args});assert.ok(!r.isError,`tool failed: ${name}`);return JSON.parse(r.content[0].text);};
 const reader=await authorize('context:read'),activityWriter=await authorize('context:read context:write:activity'),memoryWriter=await authorize('context:read context:write:memory'),dietWriter=await authorize('context:read context:append:diet');
 const listed=await rpc(reader,'tools/list',{});for(const name of ['capture_memory','recall_memory','get_activity_context','append_activity','read_context','search_context'])assert.ok(listed.tools.some(t=>t.name===name));
 check('OAuth PKCE and new/old tools registered');
 const mem={memory_id:'release_memory_001',topic:'release-career',type:'exploration',summary:'职业转型先验证兴趣，尚未决定',agent:'ChatGPT-fixture',session_ref:'isolated-session-a',source_refs:['fixture:discussion'],evidence:'user_statement',stance:'considering',occurred_at:'2026-01-01T00:00:00Z',valid_from:'2026-01-01T00:00:00Z',authorization_ref:'fixture:explicit-test-authorization'};
 for(const token of [reader,activityWriter,dietWriter])assert.equal((await rpc(token,'tools/call',{name:'capture_memory',arguments:mem})).isError,true);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM personal_memory').first()).n,0);check('legacy scopes cannot capture personal memory');
 const cap=await tool(memoryWriter,'capture_memory',mem);assert.equal(cap.vault_synced,true);const firstPuts=puts;
 await tool(memoryWriter,'capture_memory',mem);assert.equal(puts,firstPuts);
 const rec=await tool(reader,'recall_memory',{query:'career change'});assert.equal(rec.matches[0].id,mem.memory_id);const hit=rec.matches[0];assert.equal(files.get(hit.source.path).text.split('\n')[hit.source.startLine-1],hit.summary);
 check('cross-client-identity capture, verified WebDAV, idempotency and recall citation');
 const revision={...mem,memory_id:'release_memory_002',supersedes:mem.memory_id,summary:'职业转型目前暂停，先积累实践经验',agent:'Codex-fixture',occurred_at:'2026-02-01T00:00:00Z',valid_from:'2026-02-01T00:00:00Z'};
 await tool(memoryWriter,'capture_memory',revision);
 assert.equal((await tool(reader,'recall_memory',{query:'职业转型',types:['exploration']})).matches[0].id,revision.memory_id);
 assert.equal((await tool(reader,'recall_memory',{query:'职业转型',types:['exploration'],mode:'timeline'})).matches.length,2);check('current revision and retained timeline');
 const activity={event_id:'release_activity_001',project:'release-project',project_name:'Release fixture',task_id:'release-task',task_name:'Fixture task',agent:'Fixture',session_ref:'fixture',occurred_at:'2026-01-01T00:00:00Z',kind:'progress',evidence:'observed_action',status:'in_progress',summary:'隔离演练中',sources:['fixture:rehearsal']};
 await tool(activityWriter,'append_activity',activity);assert.equal((await tool(reader,'get_activity_context',{project:'release-project',date:'2026-01-01'})).activities[0].event_id,activity.event_id);
 await tool(dietWriter,'append_diet_record',{date:'2026-01-01',text:'Fixture meal',record_id:'release_diet_001'});check('old Activity/read/diet APIs preserved');
 assert.equal((await request('/__local_cron',{method:'POST'})).status,200);
 const state=JSON.parse(await db.prepare("SELECT value FROM index_meta WHERE key='sync_state'").first('value'));assert.equal(state.complete,true);assert.equal(state.retiredDirectories,1);assert.equal(state.queue.length,0);
 const noteRecall=await tool(reader,'recall_memory',{query:'验证兴趣',mode:'timeline'});assert.ok(noteRecall.matches.some(h=>h.kind==='note'&&h.id==='knowledge/history.md'));check('404 directory retired, subsequent indexing complete and existing Markdown recalled');
 outage=true;const pending=await tool(memoryWriter,'capture_memory',{...mem,memory_id:'release_pending_003',topic:'release-pending',summary:'Pending fixture'});assert.equal(pending.vault_synced,false);outage=false;
 await db.prepare('UPDATE personal_memory SET retry_after=0 WHERE memory_id=?').bind('release_pending_003').run();await request('/__local_cron',{method:'POST'});assert.equal((await db.prepare('SELECT vault_synced FROM personal_memory WHERE memory_id=?').bind('release_pending_003').first()).vault_synced,1);check('WebDAV failure durable queue and scheduled retry');
 const view='Agent共享/个人记忆/主题/release-career.md';files.set(view,{text:'Manual fixture edit',v:99});assert.equal((await tool(memoryWriter,'capture_memory',revision)).view_conflict,true);assert.equal(files.get(view).text,'Manual fixture edit');check('manual view conflict preserved');
 await mf.setOptions(opts(prior));db=await mf.getD1Database('SEARCH_DB');const old=await rpc(reader,'tools/list',{});assert.ok(!old.tools.some(t=>t.name==='capture_memory'));assert.equal((await tool(reader,'get_activity_context',{project:'release-project',date:'2026-01-01'})).activities[0].event_id,activity.event_id);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM personal_memory').first()).n,3);check('Worker rollback to V2 retains D1 memory and existing OAuth/Activity');
 await mf.setOptions(opts(current));db=await mf.getD1Database('SEARCH_DB');assert.equal((await tool(reader,'recall_memory',{query:'职业转型',types:['exploration']})).matches[0].id,revision.memory_id);check('V3 restored after rollback without data reset');
 // Separate runtime avoids in-flight MCP waitUntil work affecting the recovery regression.
 const repro=new Miniflare(opts(current));try{
 let rd=await repro.getD1Database('SEARCH_DB');await rd.exec((await readFile('schema.sql','utf8')).split('\n').filter(l=>!l.trim().startsWith('--')).join(' '));
 await rd.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
 await rd.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)").bind('knowledge/history.md',files.get('knowledge/history.md').text,files.get('knowledge/history.md').text.toLowerCase(),64,null,'1',new Date().toISOString(),'previous-generation').run();
 await rd.prepare("INSERT INTO index_meta VALUES('sync_state',?)").bind(JSON.stringify({generation:'2026-11-14T18:05:13.013Z',queue:Array.from({length:33},()=>({path:'removed',offset:0})),pending:[],complete:false,skipped:[]})).run();
 for(let i=0;i<4;i++){await repro.dispatchFetch(origin+'/__local_cron',{method:'POST'});if(i===1){await repro.setOptions(opts(current));rd=await repro.getD1Database('SEARCH_DB');}}
 const waiting=JSON.parse(await rd.prepare("SELECT value FROM index_meta WHERE key='sync_state'").first('value'));
 const retained=!!(await rd.prepare("SELECT path FROM notes WHERE path='knowledge/history.md'").first());
 assert.equal(retained,true);assert.equal(waiting.complete,false);assert.deepEqual(waiting.queue,[{path:'',offset:0}]);
 assert.equal(await rd.prepare("SELECT value FROM index_meta WHERE key='last_full_scan_at'").first('value'),null);
 await repro.dispatchFetch(origin+'/__local_cron',{method:'POST'});
 const finished=JSON.parse(await rd.prepare("SELECT value FROM index_meta WHERE key='sync_state'").first('value'));
 assert.equal(finished.complete,true);assert.ok(await rd.prepare("SELECT value FROM index_meta WHERE key='last_full_scan_at'").first('value'));
 assert.ok(await rd.prepare("SELECT path FROM notes WHERE path='knowledge/history.md'").first());
 report.push({name:'stale generation retains existing notes until a fresh root traversal completes',passed:true,old_generation_drain_cycles:4,new_root_traversal_cycles:1});console.log(JSON.stringify(report.at(-1)));
 await rd.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)').bind('deleted-fixture.md','old','old',3,null,'old',new Date().toISOString(),'previous').run();
 finished.nextScanAfter=0;
 await rd.prepare("UPDATE index_meta SET value=? WHERE key='sync_state'").bind(JSON.stringify(finished)).run();
 await repro.dispatchFetch(origin+'/__local_cron',{method:'POST'});
 assert.ok(await rd.prepare("SELECT path FROM notes WHERE path='deleted-fixture.md'").first(),'directory absence must retain until GET verification');
 await repro.dispatchFetch(origin+'/__local_cron',{method:'POST'});
 assert.equal(await rd.prepare("SELECT path FROM notes WHERE path='deleted-fixture.md'").first(),null);
 const cleaned=JSON.parse(await rd.prepare("SELECT value FROM index_meta WHERE key='sync_state'").first('value'));
 assert.deepEqual(cleaned.deletions.map(d=>[d.path,d.reason]),[['deleted-fixture.md','verified_note_404']]);
 check('independent note 404 precise cleanup through real workerd D1 binding');
 }finally{await repro.dispose();}
 await writeFile(out+'/results.json',JSON.stringify({runtime:'local workerd + D1 + KV; synthetic WebDAV; not real clients',commit:process.env.RELEASE_COMMIT||'working tree',checks:report,network_requests_intercepted:external,conditional_puts:puts},null,2));
}finally{await mf.dispose();}
