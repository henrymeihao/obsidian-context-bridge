import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// The existing filename integration harness, shared by the reliability scenarios.
export async function workerdFixture(outboundService,{persistPath}={}) {
  const {outputFiles}=await build({stdin:{contents:`
    import worker,{createMcpServer} from ${JSON.stringify(process.env.OCB_TEST_BUNDLE||'./src/index.ts')};
    import {captureMemory,MEMORY_SCOPE} from './src/memory.ts';
    import {appendActivity} from './src/activity.ts';
    import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
    export default {async fetch(request,env){
      const path=new URL(request.url).pathname;
      if(path==='/cron'){
        const options=request.method==='POST'?await request.json():{};
        let checkpoints=0;
        if(options.failCheckpointAt){
          const original=env.SEARCH_DB;
          env={...env,SEARCH_DB:{prepare(query){
            const statement=original.prepare(query);
            if(!query.includes("VALUES('sync_state',?)"))return statement;
            return {bind(...args){const bound=statement.bind(...args);return {async run(){
              if(++checkpoints>=options.failCheckpointAt)throw Error('Injected checkpoint outage');
              return bound.run();
            }};}};
          }}};
        }
        const jobs=[];await worker.scheduled({},env,{waitUntil(p){jobs.push(p)}});
        const settled=await Promise.allSettled(jobs);
        return Response.json({rejected:settled.filter(r=>r.status==='rejected').length,checkpoints});
      }
      if(path==='/capture')return Response.json(await captureMemory(env,await request.json(),[MEMORY_SCOPE]));
      if(path==='/activity')return Response.json(await appendActivity(env,await request.json()));
      const server=createMcpServer(env);
      const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await server.connect(transport);return transport.handleRequest(request);
    }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,format:'esm',platform:'browser',external:['cloudflare:*','node:*'],write:false});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,
    compatibilityDate:'2026-11-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
    d1Databases:{SEARCH_DB:'isolated-sync-reliability'},
    ...(persistPath?{resourcePersistencePath:persistPath}:{}),
    bindings:{ACCESS_MODE:'vault',WEBDAV_ROOT:'fixture',ALLOWED_NOTES:'',WEBDAV_USERNAME:'fixture',WEBDAV_PASSWORD:'fixture'},
    outboundService:async request=>{
      const url=new URL(request.url);
      assert.equal(url.origin,'https://dav.jianguoyun.com');
      assert.ok(url.pathname.startsWith('/dav/fixture/'),'only synthetic vault allowed');
      // Never delegate to fetch: every outbound request terminates in the mock.
      return outboundService(request);
    },
  }));
  try {
    const db=await mf.getD1Database('SEARCH_DB');
    await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('\n').filter(l=>!l.trimStart().startsWith('--')).join(' '));
    await db.prepare("INSERT OR IGNORE INTO index_meta VALUES('root','fixture')").run();
    const invoke=async(path,body={})=>{
      const response=await mf.dispatchFetch('https://fixture.invalid'+path,{method:'POST',body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());return response.json();
    };
    const tool=async(name,args)=>{
      const response=await mf.dispatchFetch('https://fixture.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
      assert.equal(response.status,200);const rpc=await response.json();assert.ok(!rpc.result.isError,JSON.stringify(rpc));
      return JSON.parse(rpc.result.content[0].text);
    };
    return {mf,db,invoke,tool,dispose:()=>mf.dispose()};
  } catch(error) {await mf.dispose();throw error;}
}
