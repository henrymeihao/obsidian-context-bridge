import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './activity-fixture.js';
import {recallMemory,recallLimits} from '../src/recall.js';

// Fictional, structurally reproducing natural-language requests that failed in 4A.
// No private paths, personal statements or production corpus are embedded here.
test('rare title entities beat broad diaries in Chinese and mixed natural questions',async()=>{
 const f=fixture();try{
  f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
  const insert=f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)');
  const rows=[['travel/202504琥珀岛.md','琥珀岛行程记录'],['learning/陶艺入门.md','陶艺入门的学习笔记'],['work/AI时代工程师的价值.md','工程师的价值']];
  for(let i=0;i<210;i++){const text='2025年旅行记录，学习笔记，AI时代工程师的价值。'.repeat(50);insert.run(`diary/${i}.md`,text,text.toLowerCase(),text.length,null,null,'2026-01-01','fixture');}
  for(const [path,text] of rows)insert.run(path,text,text.toLowerCase(),text.length,null,null,'2026-01-01','fixture');
  for(const [query,path] of [['找一下我2025年琥珀岛旅行的记录',rows[0][0]],['找一下我的陶艺入门学习笔记',rows[1][0]],['AI时代工程师还有什么价值，我以前写过什么？',rows[2][0]]]){
   const result=await recallMemory(f.env,{query,limit:5}); assert.ok(result.matches.some(h=>h.id===path),query+JSON.stringify(result.matches.map(h=>[h.id,h.score])));
  }
 }finally{f.sql.close();}
});

test('long-note late matches retain exact CRLF/CR line provenance without transferring full bodies',async()=>{
 const f=fixture();try{
  f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
  const insert=f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)');
  for(const newline of ['\r\n','\r','\n']){
   const path=`knowledge/${newline.length}-${newline.charCodeAt(0)}.md`;
   const text=('neutral line'+newline).repeat(10000)+'quartzneedle '+('x'.repeat(3000))+newline;
   insert.run(path,text,text.toLowerCase(),text.length,null,null,'2026-01-01','fixture');
  }
  const stages:{rows:number;chars:number}[]=[];
  const original=f.env.SEARCH_DB;
  const db={prepare(sql:string){const s=original.prepare(sql);const wrap=(q:D1PreparedStatement):any=>({bind(...p:any[]){return wrap(q.bind(...p));},first:(c?:string)=>q.first(c as any),async all(){const r=await q.all<any>();if(sql.includes('FROM candidates'))stages.push({rows:r.results.length,chars:JSON.stringify(r.results).length});return r;}});return wrap(s);}};
  const r=await recallMemory({...f.env,SEARCH_DB:db as any},{query:'quartzneedle',limit:5});
  assert.equal(r.matches.length,3);
  for(const h of r.matches){const text=f.sql.prepare('SELECT content FROM notes WHERE path=?').get(h.id) as any;const line=text.content.replace(/\r\n?/g,'\n').split('\n')[h.source.startLine-1];assert.equal(h.source.startLine,10001);assert.ok(line.includes(h.summary));assert.ok(h.summary.startsWith('quartzneedle'));assert.ok(h.summary.length<=recallLimits.excerptChars);}
  assert.ok(stages.every(s=>s.chars<10000),'candidate payload must not grow with body length');
 }finally{f.sql.close();}
});

test('maximum query and large corpus have bounded candidates, response text and query count',async()=>{
 const f=fixture();try{
  f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
  const words=Array.from({length:45},(_,i)=>`topic${i}`).join(' ');
  const text=(words+'\n').repeat(100);
  const insert=f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)');
  for(let i=0;i<230;i++)insert.run(`fixture/${i}.md`,text,text.toLowerCase(),text.length,null,null,'2026-01-01','fixture');
  const stages:any[]=[];const original=f.env.SEARCH_DB;
  const db={prepare(sql:string){const s=original.prepare(sql);const wrap=(q:D1PreparedStatement):any=>({bind(...p:any[]){return wrap(q.bind(...p));},async first(c?:string){stages.push({rows:1});return q.first(c as any);},async all(){const r=await q.all<any>();stages.push({rows:r.results.length,notes:sql.includes('FROM candidates'),chars:JSON.stringify(r.results).length});return r;}});return wrap(s);}};
  const query=(words+' '+ '职业转型 人工智能 旅行 远程办公 偏好 决定 测试 记忆 '+'q'.repeat(500)).slice(0,500);
  assert.equal(query.length,500);
  const phases:any[]=[];
  const r=await recallMemory({...f.env,SEARCH_DB:db as any},{query,limit:50},event=>phases.push(event));
  const tokens=phases.find(p=>p.stage==='expand_compile').count;
  assert.ok(tokens<=recallLimits.sqlTokens);
  assert.ok(tokens*phases.find(p=>p.stage==='score_candidates').count<=recallLimits.candidateTokenBudget);
  assert.equal(r.candidate_truncated,true);
  assert.ok(stages.length<=9,'expansion must not fan out into per-term queries');
  assert.ok(stages.filter(s=>s.notes).every(s=>s.rows<=recallLimits.noteCandidates+1&&s.chars<300000));
  assert.ok(r.matches.length<=50);assert.ok(r.matches.every(h=>h.summary.length<=recallLimits.excerptChars));
 }finally{f.sql.close();}
});

test('title-only candidate/topic filters use notes.path, not json_each.path; deep contradictory stage is skipped',async()=>{
 const f=fixture();try{
  f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
  const insert=f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)');
  insert.run('knowledge/ceramics.md','unrelated body','unrelated body',14,null,null,'2026-01-01','fixture');
  assert.equal((await recallMemory(f.env,{query:'ceramics',topics:['ceramics']})).matches[0]?.id,'knowledge/ceramics.md');
  const text='unrelated material '.repeat(1000)+' Phase 4 MCP connectivity test';
  insert.run('knowledge/client.md',text,text.toLowerCase(),text.length,null,null,'2026-01-01','fixture');
  assert.equal((await recallMemory(f.env,{query:'第三阶段客户端联通性测试记忆'})).matches.length,0);
 }finally{f.sql.close();}
});

test('a note changing between ranking and excerpt extraction is omitted rather than misquoted',async()=>{
 const f=fixture();try{
  f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
  f.sql.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)').run('knowledge/quartz.md','quartz evidence','quartz evidence',15,null,null,'2026-01-01','fixture');
  const original=f.env.SEARCH_DB.prepare.bind(f.env.SEARCH_DB);
  f.env.SEARCH_DB.prepare=((sql:string)=>{if(sql.includes('WITH normalized'))f.sql.prepare('UPDATE notes SET content=?,indexed_at=?').run('unrelated replacement','2026-01-02');return original(sql);}) as any;
  const result=await recallMemory(f.env,{query:'quartz'});
  assert.equal(result.matches.length,0);assert.equal(result.insufficient_evidence,true);assert.equal(result.candidate_truncated,true);
 }finally{f.sql.close();}
});

