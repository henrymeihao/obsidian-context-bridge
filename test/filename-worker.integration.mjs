import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('scheduled Worker refreshes D1 and indexed filename MCP returns fresh paths without WebDAV',async()=>{
  const {outputFiles}=await build({stdin:{contents:`
    import worker,{createMcpServer} from './src/index.ts';
    import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
    export default {async fetch(request,env){
      if(new URL(request.url).pathname==='/cron'){
        const jobs=[];await worker.scheduled({},env,{waitUntil(p){jobs.push(p)}});await Promise.all(jobs);return Response.json({done:true});
      }
      const server=createMcpServer(env);
      const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await server.connect(transport);return transport.handleRequest(request);
    }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,format:'esm',platform:'browser',external:['cloudflare:*','node:*'],write:false});
  let outbound=0;
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,
    compatibilityDate:'2026-11-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
    d1Databases:{SEARCH_DB:'filename-cron'},bindings:{ACCESS_MODE:'vault',WEBDAV_ROOT:'fixture',ALLOWED_NOTES:'',WEBDAV_USERNAME:'fixture',WEBDAV_PASSWORD:'fixture'},
    outboundService:async req=>{
      outbound++;const url=new URL(req.url);assert.equal(url.origin,'https://dav.jianguoyun.com');
      if(req.method==='PROPFIND'){
        assert.equal(url.pathname,'/dav/fixture/');
        return new Response('<multistatus xmlns="DAV:"><response><href>/dav/fixture/%C3%89T%C3%89.md</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype/><getcontentlength>7</getcontentlength><getetag>v1</getetag></prop></propstat></response></multistatus>',{status:207});
      }
      assert.equal(req.method,'GET');assert.equal(decodeURIComponent(url.pathname),'/dav/fixture/ÉTÉ.md');
      return new Response('fixture',{headers:{etag:'v1'}});
    },
  }));
  try{
    const db=await mf.getD1Database('SEARCH_DB');
    await db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8').split('\n').filter(l=>!l.trimStart().startsWith('--')).join(' '));
    await db.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
    assert.equal((await mf.dispatchFetch('https://fixture.invalid/cron')).status,200);
    assert.equal(outbound,2);
    const metaBefore=await db.prepare('SELECT * FROM index_meta ORDER BY key').all();
    const response=await mf.dispatchFetch('https://fixture.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_context',arguments:{mode:'filename_indexed',query:'été'}}})});
    assert.equal(response.status,200);const rpc=await response.json();assert.ok(!rpc.result.isError,JSON.stringify(rpc));
    const result=JSON.parse(rpc.result.content[0].text);
    assert.deepEqual(result.matches.map(m=>m.path),['ÉTÉ.md']);assert.ok(result.lastFullScanAt);assert.ok(result.matches[0].indexedAt);
    assert.equal(outbound,2);assert.equal(result.directoriesRequested,0);
    assert.deepEqual((await db.prepare('SELECT * FROM index_meta ORDER BY key').all()).results,metaBefore.results);
  }finally{await mf.dispose();}
});
