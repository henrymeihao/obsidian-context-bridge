import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './activity-fixture.js';
import {captureMemory,MEMORY_SCOPE} from '../src/memory.js';
import {recallMemory} from '../src/recall.js';
import {queryTerms,relevance} from '../src/recall-query.js';
import {appendActivity} from '../src/activity.js';

// Entirely fictional records, with ground truth fixed before querying.
const cases=[
 {id:'fixture_connect_03',topic:'client-validation',summary:'Phase 3 MCP connectivity test only.',type:'working_state',queries:['第三阶段客户端联通性测试记忆','Phase 3 MCP connectivity test','第三阶段 MCP connectivity 验证']},
 {id:'fixture_career_01',topic:'career-direction',summary:'Decided on a career change after comparing transferable skills.',type:'decision',queries:['职业转型的决定','career change decision','转行 decision']},
 {id:'fixture_travel_01',topic:'mountain-trip',summary:'Completed a hiking trip in the mountains.',type:'experience',queries:['徒步旅行','hiking trip','徒步 trip']},
 {id:'fixture_ai_view_01',topic:'model-judgment',summary:'AI should assist human judgment rather than replace it.',type:'exploration',queries:['人工智能与人的判断','AI human judgment','人工智能 judgment']},
 {id:'fixture_life_01',topic:'work-arrangement',summary:'Prefer remote work for a stable daily routine.',type:'preference',queries:['远程办公偏好','remote work preference','远程工作 preference']},
] as const;
function setup(){const f=fixture();f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();return f;}
async function seed(f:ReturnType<typeof setup>,c:{id:string;topic:string;summary:string;type:string}){
 return captureMemory(f.env,{memory_id:c.id,topic:c.topic,type:c.type,summary:c.summary,agent:'fixture-agent',session_ref:'fictional quality fixture',source_refs:['fixture:statement'],evidence:'user_statement',stance:'confirmed',occurred_at:'2026-01-01T00:00:00Z',valid_from:'2026-01-01T00:00:00Z',authorization_ref:'fixture:owner-authorized'},[MEMORY_SCOPE],f.fetcher);
}
test('Chinese, English and mixed queries retrieve five independent themes through SQL candidate generation',async()=>{
 const f=setup();try{
  for(const c of cases)await seed(f,c);
  await seed(f,{...cases[0],id:'fixture_connect_04',summary:'Phase 4 MCP connectivity test only.'});
  for(const c of cases)for(const query of c.queries){
   const r=await recallMemory(f.env,{query,limit:5});
   assert.equal(r.matches[0]?.id,c.id,query);
   assert.ok(r.matches.slice(0,5).some(h=>h.id===c.id));
   const hit=r.matches[0],source=f.files.get(hit.source.path)!;
   assert.equal(source.text.split('\n')[hit.source.startLine-1],hit.summary);
   assert.equal(hit.evidence,'user_statement');
   if(c.id==='fixture_connect_03')assert.ok(!r.matches.some(h=>h.id==='fixture_connect_04'));
  }
 }finally{f.sql.close();}
});
test('expansion fuses Markdown and Activity candidates; exact stage/topic survives a distractor candidate cap',async()=>{
 const f=setup();try{
  const insert=f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)');
  for(let i=0;i<220;i++)insert.run(`noise/${i}.md`,'Memory test','','',null,null,'2026-01-01','fixture');
  insert.run('knowledge/client-check.md','Phase 3 MCP connectivity test','','',null,null,'2020-01-01','fixture');
  const r=await recallMemory(f.env,{query:cases[0].queries[0],limit:5});
  assert.equal(r.matches[0]?.id,'knowledge/client-check.md');
  assert.equal(r.candidate_truncated,true);
  await appendActivity(f.env,{event_id:'fixture_project_progress',project:'client-validation',project_name:'Fixture',task_id:'validation',task_name:'客户端验证',agent:'fixture',session_ref:'fixture',occurred_at:'2026-01-01T00:00:00Z',kind:'progress',evidence:'observed_action',status:'completed',summary:'Phase 3 MCP connectivity test',sources:['fixture']},f.fetcher);
  assert.ok((await recallMemory(f.env,{query:cases[0].queries[0],limit:5})).matches.some(h=>h.id==='fixture_project_progress'));
 }finally{f.sql.close();}
});
test('NFKC, ordinal stages, identifier separators and word boundaries work without record-specific aliases',async()=>{
 const f=setup();try{
  await seed(f,{...cases[0],summary:'ＰＨＡＳＥ ３ ＭＣＰ ＣＯＮＮＥＣＴＩＶＩＴＹ ＴＥＳＴ'});
  assert.equal((await recallMemory(f.env,{query:'第三阶段客户端联通性测试记忆'})).matches[0]?.id,cases[0].id);
  assert.ok(relevance('client connectivity acceptance','stage-3-validation',queryTerms('第三阶段客户端联通性验证'))>0);
  assert.equal(relevance('chair repairs and airplane parts','other',queryTerms('AI')),0);
  assert.equal(relevance('templates and planetary orbit','other',queryTerms('plan')),0);
  assert.equal((await recallMemory(f.env,{query:'不存在的火星记忆'})).insufficient_evidence,true);
  assert.equal((await recallMemory(f.env,{query:'---'})).matches.length,0,'normalization must not introduce an empty match-all token');
 }finally{f.sql.close();}
});
test('short English entities are bounded before candidate truncation, not only during reranking',async()=>{
 const f=setup();try{
  const insert=f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)');
  for(let i=0;i<220;i++)insert.run(`chair/${i}.md`,'airplane repairs','','',null,null,'2026-01-01','fixture');
  insert.run('z-relevant.md','AI judgment','','',null,null,'2020-01-01','fixture');
  const r=await recallMemory(f.env,{query:'AI'});assert.deepEqual(r.matches.map(h=>h.id),['z-relevant.md']);
  assert.equal(r.candidate_truncated,false);
  for(let i=0;i<220;i++)insert.run(`testosterone/${i}.md`,'template building','','',null,null,'2026-01-01','fixture');
  insert.run('z-test.md','test','','',null,null,'2020-01-01','fixture');
  assert.deepEqual((await recallMemory(f.env,{query:'test'})).matches.map(h=>h.id),['z-test.md']);
 }finally{f.sql.close();}
});
