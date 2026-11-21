// Offline release validation. Requires a restored SQLite backup and a private output
// directory. Never reads deployment credentials or contacts a remote service.
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {syncIndex} from '../src/sync.js';
const args=process.argv.slice(2),option=(key:string)=>args[args.indexOf(key)+1];
if(!args.includes('--backup-sqlite')||!args.includes('--report-dir'))throw new Error('Required: --backup-sqlite PATH --report-dir PRIVATE_DIRECTORY');
const source=resolve(option('--backup-sqlite')),out=resolve(option('--report-dir'));
await mkdir(out,{recursive:true});
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const originalHash=sha(await readFile(source));
const baselineRef=option('--baseline');
let baseline:typeof syncIndex|undefined;
if(args.includes('--baseline')){
  if(!/^[a-f0-9]{7,40}$/.test(baselineRef))throw new Error('Baseline must be a commit hash');
  const code=execFileSync('git',['show',`${baselineRef}:src/sync.ts`],{encoding:'utf8',windowsHide:true});
  const rewritten=code.replaceAll("'./read.js'",JSON.stringify(pathToFileURL(resolve('src/read.ts')).href)).replaceAll("'./search.js'",JSON.stringify(pathToFileURL(resolve('src/search.ts')).href));
  const file=join(out,'baseline-sync.ts');await writeFile(file,rewritten);baseline=(await import(pathToFileURL(file).href)).syncIndex;
}
function adapter(sql:DatabaseSync){return {prepare(query:string){let values:any[]=[];const stmt={bind(...v:any[]){values=v;return stmt;},async run(){return sql.prepare(query).run(...values);},async first(column?:string){const r=sql.prepare(query).get(...values) as any;return column?r?.[column]??null:r??null;},async all(){return {results:sql.prepare(query).all(...values)};}};return stmt;}} as unknown as D1Database;}
const privateDetails:any={deletions:[],baselineDeleted:[]};
async function scenario(name:string,run:typeof syncIndex){
  const file=join(out,name+'.sqlite');assert.notEqual(source,file);await copyFile(source,file);
  let sql=new DatabaseSync(file);
  const root=sql.prepare("SELECT value FROM index_meta WHERE key='root'").get()!.value as string;
  const initial=sql.prepare('SELECT * FROM notes ORDER BY path').all() as any[];
  const activityDigest=()=>sha(JSON.stringify(sql.prepare('SELECT * FROM shared_activity ORDER BY vault,event_id').all()));
  const activityBefore=activityDigest();
  const originalState=JSON.parse(sql.prepare("SELECT value FROM index_meta WHERE key='sync_state'").get()!.value as string);
  assert.equal(initial.length,638);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM shared_activity').get()!.n,68);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM index_meta').get()!.n,7);
  const unmarked=initial.filter(n=>n.seen_generation!==originalState.generation);assert.equal(unmarked.length,286);
  let env={SEARCH_DB:adapter(sql),ACCESS_MODE:'vault',WEBDAV_ROOT:root,ALLOWED_NOTES:'',WEBDAV_USERNAME:'offline-fixture',WEBDAV_PASSWORD:'offline-fixture'};
  const state=()=>JSON.parse(sql.prepare("SELECT value FROM index_meta WHERE key='sync_state'").get()!.value as string);
  // The copied lock belongs to a production process, not this isolated runtime.
  sql.prepare("DELETE FROM index_meta WHERE key='sync_lock'").run();
  for(let i=0;i<4;i++)await run(env,async()=>new Response(null,{status:404}));
  const afterOld=sql.prepare('SELECT path,content,lower_content FROM notes ORDER BY path').all() as any[];
  if(name==='baseline'){
    const kept=new Set(afterOld.map(r=>r.path));privateDetails.baselineDeleted=initial.filter(r=>!kept.has(r.path)).map(r=>({path:r.path,reason:'unseen_in_stale_generation_without_independent_existence_check'}));
    sql.close();return {initial:638,afterOld:afterOld.length,unmarkedDeleted:privateDetails.baselineDeleted.length};
  }
  assert.equal(afterOld.length,638);for(const row of initial)assert.equal(afterOld.find(r=>r.path===row.path)!.content,row.content);
  assert.equal(state().complete,false);assert.equal(state().scanVersion,2);
  const deleted=unmarked[0],omittedButExisting=unmarked[1];
  const listingRows=initial.filter(n=>n.path!==deleted.path&&n.path!==omittedButExisting.path);
  const sources=new Map(initial.filter(n=>n.path!==deleted.path).map(n=>[n.path,n]));
  const prefix='/dav/'+root.split('/').map(encodeURIComponent).join('/')+'/';
  const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
  const verified404=new Set<string>();let requests=0;
  const fetcher=(async(url:any,init:RequestInit={})=>{
    requests++;assert.ok(['GET','PROPFIND'].includes(init.method!),'no source writes permitted');
    const u=new URL(String(url));assert.equal(u.origin,'https://dav.jianguoyun.com');assert.ok(u.pathname.startsWith(prefix));
    const path=decodeURIComponent(u.pathname.slice(prefix.length));
    if(init.method==='GET'){
      const note=sources.get(path);if(!note){verified404.add(path);return new Response(null,{status:404});}
      return new Response(note.content,{headers:{etag:note.etag||'offline-etag'}});
    }
    const parent=path.replace(/\/$/,'');const start=parent?parent+'/':'';const dirs=new Set<string>();const notes:any[]=[];
    for(const note of listingRows)if(note.path.startsWith(start)){const tail=note.path.slice(start.length);if(tail.includes('/'))dirs.add(start+tail.split('/')[0]);else notes.push(note);}
    const item=(p:string,folder:boolean,note?:any)=>`<response><href>${esc(prefix+p.split('/').map(encodeURIComponent).join('/')+(folder?'/':''))}</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype>${folder?'<collection/>':''}</resourcetype>${note?.etag?`<getetag>${esc(note.etag)}</getetag>`:''}${note?.modified?`<getlastmodified>${esc(note.modified)}</getlastmodified>`:''}${note?`<getcontentlength>${note.bytes}</getcontentlength>`:''}</prop></propstat></response>`;
    return new Response(`<multistatus xmlns="DAV:"><response><href>${esc(prefix)}</href></response>${[...dirs].map(d=>item(d,true)).join('')}${notes.map(n=>item(n.path,false,n)).join('')}</multistatus>`,{status:207});
  }) as typeof fetch;
  let cycles=0,restarted=false;
  while(!state().complete&&cycles<400){
    await run(env,fetcher);cycles++;
    if(!restarted&&cycles===2){sql.close();sql=new DatabaseSync(file);env={...env,SEARCH_DB:adapter(sql)};restarted=true;}
  }
  assert.equal(state().complete,true,'bounded traversal must finish');
  const after=sql.prepare('SELECT * FROM notes ORDER BY path').all() as any[];
  assert.equal(after.length,637);assert.ok(!after.some(n=>n.path===deleted.path));
  for(const row of after)assert.equal(row.content,sources.get(row.path)!.content,'all surviving source/index content must agree');
  assert.ok(after.some(n=>n.path===omittedButExisting.path),'listing omission alone cannot delete');
  assert.equal(activityDigest(),activityBefore);assert.ok(verified404.has(deleted.path));
  privateDetails.deletions=state().deletions;assert.deepEqual(privateDetails.deletions.map((r:any)=>r.path),[deleted.path]);
  const stableContent=()=>sha(JSON.stringify(sql.prepare('SELECT path,content,lower_content FROM notes ORDER BY path').all()));
  const beforeRepeat=stableContent();await run(env,fetcher);assert.equal(stableContent(),beforeRepeat);
  const repeatState=state();repeatState.nextScanAfter=0;
  sql.prepare("UPDATE index_meta SET value=? WHERE key='sync_state'").run(JSON.stringify(repeatState));
  let freshRepeatCycles=0;
  do{await run(env,fetcher);freshRepeatCycles++;}while(!state().complete&&freshRepeatCycles<400);
  assert.equal(state().complete,true);assert.equal(stableContent(),beforeRepeat);assert.equal(state().deletions?.length||0,0);assert.equal(activityDigest(),activityBefore);
  const result={initial:638,afterOld:638,unmarkedRetainedAfterOld:286,afterFresh:637,deleted:1,deletionReasons:['verified_note_404'],existingButOmittedRetained:true,survivingSourceContentMatches:637,activityRows:68,activityFingerprintUnchanged:true,restarted,cycles,requests,freshRepeatCycles,idempotent:true};sql.close();return result;
}
try{
  const before=baseline?await scenario('baseline',baseline):null;
  const after=await scenario('fixed',syncIndex);
  assert.equal(sha(await readFile(source)),originalHash,'original backup must remain unchanged');
  await writeFile(join(out,'private-deletion-details.json'),JSON.stringify(privateDetails,null,2));
  const report={network:'offline simulated WebDAV only; no production operations',backupSha256:originalHash,before,after};await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(out,'failure-private.txt'),String((error as Error).stack));console.error('Offline backup validation failed; details are in the private report directory.');process.exitCode=1;}
