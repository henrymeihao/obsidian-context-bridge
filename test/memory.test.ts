import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './activity-fixture.js';
import { captureMemory, syncMemories, memoryPath, MEMORY_SCOPE, memorySchema } from '../src/memory.js';
import { recallMemory } from '../src/recall.js';
import { appendActivity } from '../src/activity.js';
const scopes=[MEMORY_SCOPE];
const base={memory_id:'memory_career_001',topic:'career-transition',type:'exploration',summary:'用户正在考虑职业转型到产品设计，尚未作出决定',context:'虚构测试人物；讨论可复用的技能迁移方法',agent:'ChatGPT',session_ref:'fixture-chat-a',source_refs:['fixture:explicit-user-discussion'],evidence:'user_statement',stance:'considering',occurred_at:'2026-01-01T00:00:00Z',valid_from:'2026-01-01T00:00:00Z',authorization_ref:'fixture:owner-authorized-memory'};
function setup(){const f=fixture();f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();return f;}

test('career discussion survives cross-agent recall with provenance and real summary line',async()=>{
  const f=setup(),r=await captureMemory(f.env,base,scopes,f.fetcher);assert.equal(r.vault_synced,true);
  const recalled=await recallMemory(f.env,{query:'career change'});const hit=recalled.matches[0];
  assert.equal(hit.id,base.memory_id);assert.equal(hit.stance,'considering');assert.equal(hit.evidence,'user_statement');
  for(const query of ['想转行的讨论','换职业','career transition','职业转型 career change'])assert.equal((await recallMemory(f.env,{query})).matches[0].id,base.memory_id);
  assert.equal(f.files.get(hit.source.path)!.text.split('\n')[hit.source.startLine-1],base.summary);
  const puts=f.puts;await captureMemory(f.env,base,scopes,f.fetcher);assert.equal(f.puts,puts);
  const duplicate=await captureMemory(f.env,{...base,memory_id:'memory_career_002',agent:'Codex',session_ref:'fixture-chat-b',occurred_at:'2026-01-02T00:00:00Z',valid_from:'2026-01-02T00:00:00Z'},scopes,f.fetcher);
  assert.equal(duplicate.memory_id,base.memory_id);assert.equal(duplicate.deduplicated,true);
  await assert.rejects(captureMemory(f.env,{...base,summary:'changed'},scopes,f.fetcher),/ID already/);
});

test('travel plan is not a real experience; actual experience has separate evidence',async()=>{
  const f=setup();assert.equal(memorySchema.safeParse({...base,type:'experience'}).success,false);
  await captureMemory(f.env,{...base,memory_id:'memory_trip_plan',topic:'travel-japan',summary:'计划到日本旅行，尚未出发'},scopes,f.fetcher);
  await captureMemory(f.env,{...base,memory_id:'memory_trip_done',topic:'travel-japan',type:'experience',stance:'confirmed',summary:'已完成日本旅行，步行游览京都',occurred_at:'2026-02-01T00:00:00Z',valid_from:'2026-02-01T00:00:00Z'},scopes,f.fetcher);
  const r=await recallMemory(f.env,{query:'travel',mode:'timeline'});assert.equal(r.matches.length,2);
  assert.equal(r.matches.find(h=>h.type==='experience')!.stance,'confirmed');
});

test('progressive recall preserves an unsettled episode and attributable context without inflating default recall',async()=>{
  const f=setup();
  const context='背景：虚构用户看到同事的项目，表示有些落后感。\n转折：用户说“这也可以是学习机会”。\n当前：仍在比较参与共建与独立负责模块，尚未决定。\n未决：需要核实时间投入与责任范围。';
  const episode={...base,memory_id:'memory_episode_01',topic:'career-learning',summary:'考虑如何参与团队项目，尚未决定',context,source_refs:['fixture:conversation:turns-1-4']};
  await captureMemory(f.env,episode,scopes,f.fetcher);
  const compact=await recallMemory(f.env,{query:'责任范围',types:['exploration']});
  assert.equal(compact.detail,'summary');
  assert.equal(compact.matches[0].id,episode.memory_id);
  assert.equal('context' in compact.matches[0],false);
  assert.equal('context_source' in compact.matches[0],false);
  const expanded=await recallMemory(f.env,{query:'责任范围',types:['exploration'],detail:'context'});
  assert.deepEqual(expanded.matches.map(h=>h.id),compact.matches.map(h=>h.id));
  const hit=expanded.matches[0];
  assert.equal(hit.context,context);
  assert.equal(hit.stance,'considering');
  assert.equal(hit.evidence,'user_statement');
  assert.deepEqual(hit.source_refs,episode.source_refs);
  const source=hit.context_source!;
  assert.equal(f.files.get(source.path)!.text.split('\n').slice(source.startLine-1,source.endLine).join('\n'),context);
  assert.equal(f.files.get(hit.source.path)!.text.split('\n')[hit.source.startLine-1],episode.summary);
  // A materially different situation must survive server-side content deduplication.
  const second=await captureMemory(f.env,{...episode,memory_id:'memory_episode_02',context:'用户后来了解了新的责任范围，但仍未决定。'},scopes,f.fetcher);
  assert.equal(second.deduplicated,false);
  assert.equal((await recallMemory(f.env,{query:'考虑如何参与团队项目',types:['exploration'],mode:'timeline',detail:'context'})).matches.length,2);
});

test('expanded recall does not manufacture missing context or claim pending source files exist',async()=>{
  const f=setup();f.fail=true;
  const saved=await captureMemory(f.env,{...base,context:''},scopes,f.fetcher);
  assert.equal(saved.vault_synced,false);
  const hit=(await recallMemory(f.env,{query:'职业转型',detail:'context'})).matches[0];
  assert.equal(hit.context,'');
  assert.equal(hit.context_source,undefined);
  assert.equal(hit.vault_synced,false);
  assert.equal(f.files.has(hit.source.path),false);
});

test('context citations follow live-read newline normalization and skip heading-like summary text',async()=>{
  const f=setup(),context='第一行背景\r\n第二行理由\r第三行未决';
  await captureMemory(f.env,{...base,summary:'## Context',context},scopes,f.fetcher);
  const hit=(await recallMemory(f.env,{query:'未决',detail:'context'})).matches[0],source=hit.context_source!;
  assert.equal(hit.context,context);
  const normalized=f.files.get(source.path)!.text.replace(/\r\n?/g,'\n').split('\n');
  assert.equal(normalized.slice(source.startLine-1,source.endLine).join('\n'),context.replace(/\r\n?/g,'\n'));
});

test('AI understanding revisions and changed explicit decisions retain temporal history',async()=>{
  const f=setup();
  const first={...base,memory_id:'memory_ai_first',topic:'ai-viewpoint',stance:'confirmed',summary:'AI 适合直接代替所有判断'};
  await captureMemory(f.env,first,scopes,f.fetcher);
  const next={...first,memory_id:'memory_ai_second',supersedes:first.memory_id,summary:'AI 适合提供候选，人仍需判断',occurred_at:'2026-02-01T00:00:00Z',valid_from:'2026-02-01T00:00:00Z'};
  await captureMemory(f.env,next,scopes,f.fetcher);
  assert.deepEqual((await recallMemory(f.env,{query:'人工智能'})).matches.map(h=>h.id),[next.memory_id]);
  assert.deepEqual((await recallMemory(f.env,{query:'AI',as_of:'2026-01-15T00:00:00Z'})).matches.map(h=>h.id),[first.memory_id]);
  assert.equal((await recallMemory(f.env,{query:'AI',mode:'timeline'})).matches.length,2);
  await assert.rejects(captureMemory(f.env,{...next,memory_id:'memory_ai_branch',summary:'竞争修改'},scopes,f.fetcher),/revision conflict/);
  const decision={...base,type:'decision',stance:'confirmed',summary:'决定秋季开始转行',memory_id:'memory_decision_a'};
  await captureMemory(f.env,decision,scopes,f.fetcher);
  await captureMemory(f.env,{...decision,memory_id:'memory_decision_b',supersedes:decision.memory_id,summary:'决定推迟转行到明年',valid_from:'2026-03-01T00:00:00Z',occurred_at:'2026-03-01T00:00:00Z'},scopes,f.fetcher);
  const d=await recallMemory(f.env,{query:'转行',types:['decision']});assert.equal(d.matches[0].id,'memory_decision_b');
  assert.equal((await recallMemory(f.env,{query:'转行',types:['decision'],mode:'timeline',to:'2026-02-01T00:00:00Z'})).matches[0].id,'memory_decision_a');
  assert.ok(f.files.has(memoryPath(decision.memory_id)));
});

test('scope and sensitivity guards; tentative inference cannot become fact or replace evidence',async()=>{
  const f=setup();for(const grant of [[],['context:write:activity']])await assert.rejects(captureMemory(f.env,base,grant,f.fetcher),/insufficient_scope/);
  assert.equal(f.puts,0);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM personal_memory').get()!.n,0);
  for(const invalid of [{evidence:'inference',stance:'confirmed'},{evidence:'assistant_proposal',stance:'confirmed'},{sensitivity:'sensitive'},{sensitivity:'third_party'},{type:'decision',stance:'considering'}])
    await assert.rejects(captureMemory(f.env,{...base,...invalid},scopes,f.fetcher));
  await captureMemory(f.env,base,scopes,f.fetcher);
  await assert.rejects(captureMemory(f.env,{...base,memory_id:'memory_inference',evidence:'inference',stance:'tentative',supersedes:base.memory_id},scopes,f.fetcher),/tentative/);
  await captureMemory(f.env,{...base,memory_id:'memory_sensitive',topic:'private-example',sensitivity:'sensitive',sensitive_authorization_ref:'fixture:explicit-specific-consent'},scopes,f.fetcher);
});

test('durable WebDAV outage retry, immutable event conflict and manual view preservation',async()=>{
  const f=setup();f.fail=true;const result=await captureMemory(f.env,base,scopes,f.fetcher);assert.equal(result.vault_synced,false);
  const pending=await recallMemory(f.env,{query:'转行'});assert.equal(pending.matches[0].vault_synced,false);
  f.fail=false;f.sql.exec('UPDATE personal_memory SET retry_after=0');await syncMemories(f.env,f.fetcher);
  assert.equal((await recallMemory(f.env,{query:'转行'})).matches[0].vault_synced,true);
  const path='Agent共享/个人记忆/主题/career-transition.md';f.files.set(path,{text:'手工保留',version:99});
  const again=await captureMemory(f.env,base,scopes,f.fetcher);assert.equal(again.view_conflict,true);assert.equal(f.files.get(path)!.text,'手工保留');
  assert.equal((await recallMemory(f.env,{query:'转行'})).view_conflicts.length,1);
  f.files.set(memoryPath(base.memory_id),{text:'手工原始事件',version:99});
  const conflict=await captureMemory(f.env,base,scopes,f.fetcher);assert.equal(conflict.vault_synced,false);
  assert.equal(f.sql.prepare('SELECT sync_error FROM personal_memory WHERE memory_id=?').get(base.memory_id)!.sync_error,'event_conflict');
  assert.equal(f.files.get(memoryPath(base.memory_id))!.text,'手工原始事件');
});

test('conflicting queued event does not starve healthy work; Vault boundaries remain isolated',async()=>{
  const f=setup();f.fail=true;
  await captureMemory(f.env,base,scopes,f.fetcher);
  await captureMemory(f.env,{...base,memory_id:'memory_healthy_b',topic:'healthy-subject',summary:'另一个可同步的主题'},scopes,f.fetcher);
  f.files.set(memoryPath(base.memory_id),{text:'手工冲突',version:5});f.fail=false;
  f.sql.exec('UPDATE personal_memory SET retry_after=0');await syncMemories(f.env,f.fetcher);
  assert.equal(f.sql.prepare('SELECT vault_synced FROM personal_memory WHERE memory_id=?').get('memory_healthy_b')!.vault_synced,1);
  assert.equal(f.sql.prepare('SELECT sync_error FROM personal_memory WHERE memory_id=?').get(base.memory_id)!.sync_error,'event_conflict');
  const other=await recallMemory({...f.env,WEBDAV_ROOT:'other-vault'},{query:'职业转型'});assert.equal(other.matches.length,0);
});

test('relevance merges existing Markdown and Activity, hides superseded task state and mirrored duplicates',async()=>{
  const f=setup();
  const a={event_id:'memory_activity_a',project:'demo-project',project_name:'Demo',task_id:'task-demo',task_name:'产品判断',agent:'Codex',session_ref:'fixture',occurred_at:'2026-01-01T00:00:00Z',kind:'progress',evidence:'observed_action',status:'in_progress',summary:'产品判断接口尚未部署',sources:['fixture']};
  await appendActivity(f.env,a,f.fetcher);
  await appendActivity(f.env,{...a,event_id:'memory_activity_b',occurred_at:'2026-02-01T00:00:00Z',summary:'产品判断接口受阻',status:'blocked'},f.fetcher);
  for(const [path,text] of [['knowledge/demo.md','# 主题\n产品判断需要对照证据'],['Agent共享/最近动态.md','产品判断接口尚未部署']])
    f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)').run(path,text,text.toLowerCase(),100,'2026-01-01T00:00:00Z',null,'2026-01-01T00:00:00Z','fixture');
  const result=await recallMemory(f.env,{query:'产品判断'});assert.equal(result.matches.length,2);assert.equal(result.freshness.notes_stale,true);
  assert.ok(!result.matches.some(h=>h.id===a.event_id));const hit=result.matches.find(h=>h.kind==='activity')!;
  assert.equal(f.files.get(hit.source.path)!.text.split('\n')[hit.source.startLine-1],hit.summary);
  assert.equal(result.matches.find(h=>h.kind==='note')!.source.startLine,2);
  assert.equal((await recallMemory(f.env,{query:'产品判断',mode:'timeline'})).matches.length,3);
  assert.equal((await recallMemory(f.env,{query:'不存在的火星记忆'})).insufficient_evidence,true);
  f.sql.exec("UPDATE index_meta SET value='other-vault' WHERE key='root'");
  assert.ok(!(await recallMemory(f.env,{query:'产品判断'})).matches.some(h=>h.kind==='note'));
});

test('unlinked contradictory heads are flagged; expiration does not resurrect superseded facts',async()=>{
  const f=setup();await captureMemory(f.env,base,scopes,f.fetcher);
  await captureMemory(f.env,{...base,memory_id:'memory_conflict_b',summary:'职业转型已经放弃'},scopes,f.fetcher);
  assert.equal((await recallMemory(f.env,{query:'职业转型'})).conflicts,true);
  await captureMemory(f.env,{...base,memory_id:'memory_expired_a',topic:'short-state',type:'working_state',summary:'短期测试状态',valid_until:'2026-02-01T00:00:00Z'},scopes,f.fetcher);
  assert.equal((await recallMemory(f.env,{query:'短期测试状态'})).matches.length,0);
  assert.equal((await recallMemory(f.env,{query:'短期测试状态',mode:'timeline'})).matches.length,1);
});

test('relevance finds old relevant note past 250 newer unrelated notes; SQL injection is data',async()=>{
  const f=setup();const insert=f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)');
  for(let i=0;i<250;i++)insert.run(`a${i}.md`,'无关文本','无关文本',12,'2026-10-01',null,'2026-10-01','fixture');
  insert.run('z-old.md','职业转型的技能地图','职业转型的技能地图',24,'2020-01-01',null,'2020-01-01','fixture');
  assert.equal((await recallMemory(f.env,{query:'换职业'})).matches[0].id,'z-old.md');
  assert.equal((await recallMemory(f.env,{query:"' OR 1=1 --"})).matches.length,0);
});
