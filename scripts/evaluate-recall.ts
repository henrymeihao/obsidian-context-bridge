// Synthetic corpus. Runs the actual baseline and current SQL/candidate/ranking implementations.
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture} from '../test/activity-fixture.js';
import {captureMemory,MEMORY_SCOPE} from '../src/memory.js';
import {appendActivity} from '../src/activity.js';
import {recallMemory} from '../src/recall.js';
const out=resolve('work/phase4a');await mkdir(out,{recursive:true});
const source=execFileSync('git',['show','b2d239d:src/recall.ts'],{encoding:'utf8'}).replaceAll("from './","from '../../src/");
const baselineFile=resolve(out,'baseline-recall.ts');await writeFile(baselineFile,source);
const baseline=(await import(pathToFileURL(baselineFile).href)).recallMemory;
const f=fixture();f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
const rows=[
 ['fixture_connect_03','client-validation','working_state','Phase 3 MCP connectivity test only.',['第三阶段客户端联通性测试记忆','Phase 3 MCP connectivity test','第三阶段 MCP connectivity 验证']],
 ['fixture_career_01','career-direction','decision','Decided on a career change after comparing transferable skills.',['职业转型的决定','career change decision','转行 decision']],
 ['fixture_travel_01','mountain-trip','experience','Completed a hiking trip in the mountains.',['徒步旅行','hiking trip','徒步 trip']],
 ['fixture_ai_view_01','model-judgment','exploration','AI should assist human judgment rather than replace it.',['人工智能与人的判断','AI human judgment','人工智能 judgment']],
 ['fixture_life_01','work-arrangement','preference','Prefer remote work for a stable daily routine.',['远程办公偏好','remote work preference','远程工作 preference']],
] as const;
const questions:{query:string;expected:string[]}[]=[];
for(const [id,topic,type,summary,queries] of rows){
 await captureMemory(f.env,{memory_id:id,topic,type,summary,agent:'fixture',session_ref:'fixture',source_refs:['fixture:statement'],evidence:'user_statement',stance:'confirmed',occurred_at:'2026-01-01T00:00:00Z',valid_from:'2026-01-01T00:00:00Z',authorization_ref:'fixture:authorized'},[MEMORY_SCOPE],f.fetcher);
 for(const query of queries)questions.push({query,expected:[id]});
}
await captureMemory(f.env,{memory_id:'fixture_connect_04',topic:'phase-four-validation',type:'working_state',summary:'Phase 4 MCP connectivity test only.',agent:'fixture',session_ref:'fixture',source_refs:['fixture:statement'],evidence:'observed_action',stance:'confirmed',occurred_at:'2026-01-01T00:00:00Z',valid_from:'2026-01-01T00:00:00Z',authorization_ref:'fixture:authorized'},[MEMORY_SCOPE],f.fetcher);
await appendActivity(f.env,{event_id:'fixture_project_01',project:'demo-project',project_name:'Demo',task_id:'delivery',task_name:'Project delivery',agent:'fixture',session_ref:'fixture',occurred_at:'2026-01-01T00:00:00Z',kind:'progress',evidence:'user_statement',status:'completed',summary:'Completed project verification and testing.',sources:['fixture:statement']},f.fetcher);
for(const query of ['项目验收','project verification','项目 testing'])questions.push({query,expected:['fixture_project_01']});
// Keep these semantic paraphrases outside the vocabulary tuning set; report the residual gap.
questions.push({query:'让机器列选项，人来做价值取舍',expected:['fixture_ai_view_01']});
questions.push({query:'那次靠双脚穿越山野的出行',expected:['fixture_travel_01']});
const reports=[];
for(const [version,recall] of [['baseline',baseline],['current',recallMemory]] as const){
 const results=[];
 for(const q of questions){const r=await recall(f.env,{query:q.query,limit:5}),ids=r.matches.map((h:any)=>h.id);
  results.push({...q,top5:ids,recallAt5:q.expected.filter(id=>ids.includes(id)).length/q.expected.length,falsePositives:ids.filter((id:string)=>!q.expected.includes(id))});
 }
 reports.push({version,questions:results,recallAt5:results.reduce((s,r)=>s+r.recallAt5,0)/results.length,wrongCandidates:results.reduce((s,r)=>s+r.falsePositives.length,0)});
}
const report={corpus:'Fictional: 18 curated lexical questions plus 2 untuned semantic paraphrase challenges; not a representative personal-history benchmark',questions:questions.length,reports,limitations:'Finite concept vocabulary is not general cross-language translation. Client behavior and production performance are separate gates.'};
await writeFile(resolve(out,'retrieval-comparison.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(reports.map(r=>({version:r.version,questions:r.questions.length,recallAt5:r.recallAt5,wrongCandidates:r.wrongCandidates}))));f.sql.close();
