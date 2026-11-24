// Local workerd + D1 + MCP transport; all WebDAV responses are synthetic.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, relative} from 'node:path';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = 'ebedfd4';
const delayMs = 20, repetitions = 5;
const paths = Array.from({length:32}, (_, d) => Array.from({length:25}, (_, n) =>
  `folder-${String(d).padStart(2,'0')}/${d === 31 && n < 3 ? 'photo-study-coach' : 'note'}-${n}.md`)).flat();
paths.push(...Array.from({length:27}, (_, i) => `root-${i}.md`));
const expected = paths.filter(p => p.includes('photo-study-coach')).sort();
const xml = rows => `<multistatus xmlns="DAV:">${rows.map(p => `<response><href>/dav/fixture/${p}</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype>${p.endsWith('/')?'<collection/>':''}</resourcetype><getcontentlength>7</getcontentlength><getetag>fixture</getetag></prop></propstat></response>`).join('')}</multistatus>`;

async function runtime(before) {
  const {outputFiles} = await build({stdin:{contents:`
    import {createMcpServer} from './src/index.ts';
    import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
    export default {async fetch(request,env){
      const server=createMcpServer(env);
      const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await server.connect(transport);return transport.handleRequest(request);
    }};`, resolveDir:root}, bundle:true, format:'esm', platform:'browser', external:['cloudflare:*','node:*'], write:false,
    plugins:before?[{name:'frozen-baseline',setup(b){b.onLoad({filter:/src\/(index|read|search)\.ts$/}, args=>({
      contents:execFileSync('git',['show',`${baseline}:${relative(root,args.path)}`],{cwd:root,encoding:'utf8'}),loader:'ts',resolveDir:join(root,'src'),
    }));}}]:[],
  });
  let requests=0, active=0, peak=0;
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,
    compatibilityDate:'2026-11-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
    d1Databases:{SEARCH_DB:'filename-fixture'},bindings:{ACCESS_MODE:'vault',WEBDAV_ROOT:'fixture',ALLOWED_NOTES:'',WEBDAV_USERNAME:'fixture',WEBDAV_PASSWORD:'fixture'},
    outboundService:async req=>{
      assert.equal(req.method,'PROPFIND');assert.equal(new URL(req.url).origin,'https://dav.jianguoyun.com');
      const path=decodeURIComponent(new URL(req.url).pathname).replace('/dav/fixture/','');
      requests++;active++;peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,delayMs));active--;
      const rows=path?paths.filter(p=>p.startsWith(path)):[...Array.from({length:32},(_,i)=>`folder-${String(i).padStart(2,'0')}/`),...paths.filter(p=>!p.includes('/'))];
      return new Response(xml(rows),{status:207});
    },
  }));
  const db=await mf.getD1Database('SEARCH_DB');
  await db.exec(readFileSync(join(root,'schema.sql'),'utf8').split('\n').filter(l=>!l.trimStart().startsWith('--')).join(' '));
  await db.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
  for(let i=0;i<paths.length;i+=50)await db.batch(paths.slice(i,i+50).map(path=>db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)').bind(path,'fixture','fixture',7,null,'fixture','2026-01-01T00:00:00Z','fixture')));
  return {mf,db,reset(){requests=0;peak=0;},metrics(){assert.equal(active,0);return {requests,peak};}};
}

async function measure(rt,mode) {
  rt.reset();const start=performance.now();let cursor,firstPageMs,firstPageRequests,pages=0;const found=[];
  do {
    assert.ok(pages++<20,'continuation must finish');
    const response=await rt.mf.dispatchFetch('https://fixture.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:pages,method:'tools/call',params:{name:'search_context',arguments:{mode,query:'photo-study-coach',limit:3,...(cursor?{cursor}:{})}}})});
    assert.equal(response.status,200);const rpc=await response.json();assert.ok(!rpc.error && !rpc.result.isError,JSON.stringify(rpc));
    const page=JSON.parse(rpc.result.content[0].text);found.push(...page.matches.map(m=>m.path));cursor=page.nextCursor;
    if(pages===1){firstPageMs=performance.now()-start;firstPageRequests=rt.metrics().requests;}
  }while(cursor);
  const totalMs=performance.now()-start;
  assert.deepEqual(found.sort(),expected);assert.equal(new Set(found).size,expected.length);
  const metrics=rt.metrics();if(mode==='filename_indexed')assert.equal(metrics.requests,0);
  return {firstPageMs,totalMs,pages,firstPageRequests,...metrics,matches:found.length,errors:0};
}

const old=await runtime(true),current=await runtime(false);
try {
  // Warm both runtimes before the alternating samples; no cross-call result cache.
  await measure(old,'filename');await measure(current,'filename');await measure(current,'filename_indexed');
  const samples=[];
  for(let i=0;i<repetitions;i++){
    for(const [variant,rt,mode] of [['before',old,'filename'],['after_live',current,'filename'],['after_indexed',current,'filename_indexed']]){
      const sample={iteration:i+1,variant,...await measure(rt,mode)};samples.push(sample);console.log(JSON.stringify(sample));
    }
  }
  const summarize=variant=>{
    const rows=samples.filter(r=>r.variant===variant),stats=key=>{const v=rows.map(r=>r[key]).sort((a,b)=>a-b);return {median:v[2],min:v[0],max:v.at(-1)};};
    return {variant,runs:rows.length,firstPageMs:stats('firstPageMs'),totalMs:stats('totalMs'),requests:stats('requests'),errors:rows.reduce((n,r)=>n+r.errors,0)};
  };
  const report={claim:'Local MCP transport latency and full-result parity on the same 827 synthetic indexed notes; not production latency.',baseline,delayMs,repetitions,
    boundary:'workerd HTTP MCP request through tool response, all cursor pages; excludes OAuth/network-to-Cloudflare and scheduled sync. Local D1, fixed synthetic WebDAV latency; no production credentials or data.',
    limiter:'Live traversal waits for synthetic WebDAV responses (20 ms each); indexed lookup uses local D1 path batches and MCP serialization. This does not model remote D1 latency or provider rate limits.',
    samples,summary:['before','after_live','after_indexed'].map(summarize)};
  const out=join(root,'work/filename-benchmark');mkdirSync(out,{recursive:true});writeFileSync(join(out,'results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({summary:report.summary}));
}finally{await old.mf.dispose();await current.mf.dispose();}
