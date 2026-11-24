import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workerdFixture} from './workerd-fixture.mjs';

test('scheduled Worker refreshes D1 and indexed filename MCP returns fresh paths without WebDAV',async()=>{
  let outbound=0;
  const f=await workerdFixture(async req=>{
    outbound++;const url=new URL(req.url);
    if(req.method==='PROPFIND'){
      assert.equal(url.pathname,'/dav/fixture/');
      return new Response('<multistatus xmlns="DAV:"><response><href>/dav/fixture/%C3%89T%C3%89.md</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype/><getcontentlength>7</getcontentlength><getetag>v1</getetag></prop></propstat></response></multistatus>',{status:207});
    }
    assert.equal(req.method,'GET');assert.equal(decodeURIComponent(url.pathname),'/dav/fixture/ÉTÉ.md');
    return new Response('fixture',{headers:{etag:'v1'}});
  });
  try{
    assert.equal((await f.invoke('/cron')).rejected,0);
    assert.equal(outbound,2);
    const metaBefore=await f.db.prepare('SELECT * FROM index_meta ORDER BY key').all();
    const result=await f.tool('search_context',{mode:'filename_indexed',query:'été'});
    assert.deepEqual(result.matches.map(m=>m.path),['ÉTÉ.md']);assert.ok(result.lastFullScanAt);assert.ok(result.matches[0].indexedAt);
    assert.equal(outbound,2);assert.equal(result.directoriesRequested,0);
    assert.deepEqual((await f.db.prepare('SELECT * FROM index_meta ORDER BY key').all()).results,metaBefore.results);
  }finally{await f.dispose();}
});
