// Local read-only corpus diagnostics. Never connects to Cloudflare or WebDAV.
// Cases: {cases:[{id:number|string,query:string,expected:string}]} (keep private).
import {DatabaseSync} from 'node:sqlite';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {recallMemory} from '../src/recall.js';
import {queryTerms,candidateTerms} from '../src/recall-query.js';

const options=new Map(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return [arg.slice(0,i),arg.slice(i+1)];}));
if(!options.has('--db')||!options.has('--cases'))throw Error('Required: --db=<local read-only sqlite> --cases=<private JSON> [--out=work/recall-profile] [--baseline=73e7b3b]');
const out=resolve(options.get('--out')||'work/recall-profile');
if(!out.startsWith(resolve('work')+sep))throw Error('Private output must be under gitignored work/');
await mkdir(out,{recursive:true});
const ref=options.get('--baseline')||'73e7b3b';if(!/^[a-f0-9]{7,40}$/.test(ref))throw Error('Baseline must be a commit hash');
const srcURL=pathToFileURL(fileURLToPath(new URL('../src/',import.meta.url))).href;
for(const name of ['recall-query','recall']){
 let code=execFileSync('git',['show',`${ref}:src/${name}.ts`],{encoding:'utf8'});
 if(name==='recall')code=code.replaceAll("from './",`from '${srcURL}`).replaceAll(srcURL+'recall-query.js',pathToFileURL(out+'/baseline-query.ts').href);
 await writeFile(out+(name==='recall'?'/baseline.ts':'/baseline-query.ts'),code);
}
const baseline=(await import(pathToFileURL(out+'/baseline.ts').href)).recallMemory;
const cases=JSON.parse(await readFile(resolve(options.get('--cases')!),'utf8')).cases;
const sql=new DatabaseSync(resolve(options.get('--db')!),{readOnly:true});
const root=(sql.prepare("SELECT value FROM index_meta WHERE key='root'").get() as {value:string}).value;
const cpuUs=(c:NodeJS.CpuUsage)=>c.user+c.system;
const runs=[];let stages:any[]=[],expected='';
const adapter={prepare(query:string){let params:any[]=[];const stmt={bind(...p:any[]){params=p;return stmt;},async all(){
 const start=performance.now(),cpu=process.cpuUsage();const rows=sql.prepare(query).all(...params) as any[];
 stages.push({wallMs:performance.now()-start,cpuUs:cpuUs(process.cpuUsage(cpu)),rows:rows.length,
  table:query.match(/FROM (notes|personal_memory|shared_activity|index_meta|memory_views)/)?.[1]||'metadata',expectedCandidate:rows.some(r=>r.path===expected),
  textChars:rows.reduce((n,r)=>n+(r.content?.length||0)+(r.preview?.length||0)+(r.matched?.length||0)+(r.payload?.length||0),0)});
 return {results:rows};},async first(col?:string){const r=(await stmt.all()).results[0];return col?r?.[col]??null:r??null;}};return stmt;}};
try{
 for(const [version,recall] of [['baseline',baseline],['current',recallMemory]] as const)for(const c of cases){
  expected=c.expected;stages=[];
  const expansionStart=performance.now(),tokens=candidateTerms(queryTerms(c.query));const expansionWallMs=performance.now()-expansionStart;
  const start=performance.now(),cpu=process.cpuUsage(),heap=process.memoryUsage().heapUsed;
  const phases:any[]=[];let phaseCPU=process.cpuUsage();
  const result=await recall({SEARCH_DB:adapter,ACCESS_MODE:'vault',WEBDAV_ROOT:root,ALLOWED_NOTES:''} as any,{query:c.query,limit:5},(event:any)=>{const now=process.cpuUsage();phases.push({...event,nodeCPUUs:cpuUs({user:now.user-phaseCPU.user,system:now.system-phaseCPU.system})});phaseCPU=now;});
  const totalCPUUs=cpuUs(process.cpuUsage(cpu)),wallMs=performance.now()-start;
  const sourceExists=!!sql.prepare('SELECT 1 FROM notes WHERE path=?').get(expected);
  const rank=result.matches.findIndex((h:any)=>h.source.path===expected)+1;
  runs.push({version,id:c.id,sourceExists,expectedCandidate:stages.some(s=>s.expectedCandidate),rank,hit:rank>0,
   wallMs,totalCPUUs,nonSQLCPUUs:totalCPUUs-stages.reduce((n,s)=>n+s.cpuUs,0),heapDelta:process.memoryUsage().heapUsed-heap,
   expansionWallMs,tokenCount:tokens.length,queryCount:stages.length,stages,phases});
 }
 await writeFile(out+'/metrics.json',JSON.stringify({metric:'Node process CPU includes local SQLite; subtraction is a coarse non-SQL estimate, not Worker CPU. Heap delta is not peak. No private queries, paths or note content logged.',runs},null,2));
 console.log(JSON.stringify(['baseline','current'].map(version=>({version,questions:runs.filter(r=>r.version===version).length,hits:runs.filter(r=>r.version===version&&r.hit).length}))));
}finally{sql.close();}
