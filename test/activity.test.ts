import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './activity-fixture.js';
import {appendActivity,getActivityContext,syncActivities,activitySchema,activityPath} from '../src/activity.js';

const base={event_id:'activity_test_001',project:'shared-context',project_name:'共享上下文',task_id:'mcp-write',task_name:'接通 MCP 写入',agent:'Codex',session_ref:'fixture-session',occurred_at:new Date(Date.now()-60000).toISOString(),kind:'progress',evidence:'observed_action',status:'in_progress',summary:'接口开发中，尚未部署',sources:['本次操作记录']};
test('activity verified vault write, immediate read, views and exact idempotent retries',async()=>{
  const f=fixture();const result=await appendActivity(f.env,base,f.fetcher);
  assert.equal(result.vault_synced,true);assert.equal(result.views_updated,true);
  assert.ok(f.files.get(activityPath(base.event_id))?.text.includes('尚未部署'));
  assert.ok(f.files.get('Agent共享/最近动态.md')?.text.includes('接口开发中'));
  const firstPuts=f.puts;
  await appendActivity(f.env,base,f.fetcher);assert.equal(f.puts,firstPuts);
  await assert.rejects(appendActivity(f.env,{...base,summary:'different'},f.fetcher),/already used/);
  const data=await getActivityContext(f.env,{project:base.project});
  assert.equal(data.activities.length,1);assert.equal(data.tasks[0].status,'in_progress');
  assert.equal(data.pending_vault_sync,0);
  const other=await getActivityContext({...f.env,WEBDAV_ROOT:'other'});assert.equal(other.activities.length,0);
});
test('outage retains durable activity and cron retries without losing original payload',async()=>{
  const f=fixture();f.fail=true;
  const res=await appendActivity(f.env,base,f.fetcher);assert.equal(res.status,'pending_vault_sync');assert.equal(res.vault_synced,false);
  assert.equal((await getActivityContext(f.env)).pending_vault_sync,1);
  f.fail=false;await syncActivities(f.env,f.fetcher);
  assert.equal((await getActivityContext(f.env)).pending_vault_sync,0);
  assert.ok(f.files.has(activityPath(base.event_id)));
});
test('concurrent independent events survive; same-time cursor pages do not omit/duplicate',async()=>{
  const f=fixture();
  await Promise.all([appendActivity(f.env,base,f.fetcher),appendActivity(f.env,{...base,event_id:'activity_test_002'},f.fetcher)]);
  const a=await getActivityContext(f.env,{limit:1}),b=await getActivityContext(f.env,{limit:1,cursor:a.next_cursor!});
  assert.equal(new Set([a.activities[0].event_id,b.activities[0].event_id]).size,2);assert.equal(b.next_cursor,null);
  await assert.rejects(getActivityContext(f.env,{limit:2,cursor:a.next_cursor!}),/cursor/);
});
test('proposal is attributed and cannot replace actual task state; correction retains original source',async()=>{
  const f=fixture();await appendActivity(f.env,base,f.fetcher);
  const later=new Date(Date.now()-30000).toISOString();
  await appendActivity(f.env,{...base,event_id:'activity_proposal_001',occurred_at:later,evidence:'assistant_proposal',status:'planned',kind:'discussion',summary:'建议上线'},f.fetcher);
  let context=await getActivityContext(f.env,{project:base.project});assert.equal(context.tasks[0].status,'in_progress');
  await assert.rejects(appendActivity(f.env,{...base,event_id:'activity_invalid_001',evidence:'inference',status:'completed'},f.fetcher));
  await appendActivity(f.env,{...base,event_id:'activity_correct_001',kind:'correction',supersedes:base.event_id,status:'blocked',summary:'更正：被上游服务阻塞',occurred_at:new Date(Date.now()-10000).toISOString()},f.fetcher);
  context=await getActivityContext(f.env,{project:base.project});assert.equal(context.tasks[0].status,'blocked');
  assert.ok(!context.activities.some(v=>v.event_id===base.event_id));assert.ok(f.files.has(activityPath(base.event_id)));
  await assert.rejects(appendActivity(f.env,{...base,event_id:'activity_correct_002',kind:'correction',supersedes:base.event_id,task_id:'different'},f.fetcher),/same project/);
});
test('strict schema blocks path escape; edited event is preserved and not reported verified',async()=>{
  assert.equal(activitySchema.safeParse({...base,project:'../private'}).success,false);
  assert.equal(activitySchema.safeParse({...base,path:'other.md'}).success,false);
  const f=fixture();f.files.set(activityPath(base.event_id),{text:'用户手改的内容',version:1});
  const r=await appendActivity(f.env,base,f.fetcher);assert.equal(r.vault_synced,false);
  assert.equal(f.files.get(activityPath(base.event_id))?.text,'用户手改的内容');
});
test('Beijing calendar date excludes previous local day; edited previously synced record becomes pending',async()=>{
  const f=fixture();
  await appendActivity(f.env,{...base,occurred_at:'2026-01-02T00:01:00+08:00'},f.fetcher);
  await appendActivity(f.env,{...base,event_id:'activity_prev_day_001',occurred_at:'2026-01-01T23:59:00+08:00'},f.fetcher);
  const day=await getActivityContext(f.env,{date:'2026-01-02',limit:1});
  assert.equal(day.activities.length,1);assert.equal(day.activities[0].event_id,base.event_id);assert.equal(day.next_cursor,null);
  await assert.rejects(getActivityContext(f.env,{date:'2026-02-30'}),/date/);
  const file=f.files.get(activityPath(base.event_id))!;file.text='用户修改了原记录';
  const retry=await appendActivity(f.env,{...base,occurred_at:'2026-01-02T00:01:00+08:00'},f.fetcher);
  assert.equal(retry.vault_synced,false);assert.equal((await getActivityContext(f.env)).pending_vault_sync,1);
});
test('one edited/conflicting queued record does not block unrelated pending records',async()=>{
  const f=fixture();f.fail=true;
  await appendActivity(f.env,base,f.fetcher);
  await appendActivity(f.env,{...base,event_id:'activity_pending_002'},f.fetcher);
  f.fail=false;f.files.set(activityPath(base.event_id),{text:'用户修改的记录，不能覆盖',version:1});
  await assert.rejects(syncActivities(f.env,f.fetcher),/queued records/);
  const context=await getActivityContext(f.env);assert.equal(context.pending_vault_sync,1);
  assert.equal(context.activities.find(v=>v.event_id==='activity_pending_002')?.vault_synced,true);
  assert.equal(f.files.get(activityPath(base.event_id))?.text,'用户修改的记录，不能覆盖');
});
