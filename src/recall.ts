import { z } from 'zod';
import { memoryDB, memoryTypes, publicMemory, renderMemory, type MemoryRow } from './memory.js';
import { activityPath, renderEvent } from './activity.js';
import { indexStatus, sourceReference, type SearchEnv } from './search.js';

export const recallSchema=z.object({query:z.string().trim().min(1).max(500),topics:z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/)).max(12).optional(),types:z.array(memoryTypes).max(6).optional(),
  from:z.string().datetime({offset:true}).optional(),to:z.string().datetime({offset:true}).optional(),
  mode:z.enum(['current','timeline']).default('current'),detail:z.enum(['summary','context']).default('summary').describe('summary: compact conclusions; context: also return saved personal-memory situations, reasoning and unresolved questions. Original evidence still requires reading source_refs when accessible.'),as_of:z.string().datetime({offset:true}).optional(),limit:z.number().int().min(1).max(50).default(10)}).strict()
  .refine(v=>!v.from||!v.to||Date.parse(v.from)<=Date.parse(v.to),'Invalid time range');
export type RecallOptions=z.input<typeof recallSchema>;
export {queryTerms,relevance} from './recall-query.js';
import {queryTerms,compileRelevance,candidateTerms,normalizeRecallText} from './recall-query.js';
export const recallLimits={candidatesPerStore:64,noteCandidates:64,sqlTokens:128,candidateTokenBudget:2048,notePreviewChars:512,excerptChars:1000} as const;
// Opt-in local instrumentation only. No queries, paths, content, credentials or automatic logs.
export type RecallDiagnostic={stage:string;wallMs:number;count:number};
export async function recallMemory(env:SearchEnv,raw:RecallOptions,observe?:(event:RecallDiagnostic)=>void) {
  let checkpoint=observe?performance.now():0;
  const mark=(stage:string,count:number)=>{if(observe){const now=performance.now();observe({stage,wallMs:now-checkpoint,count});checkpoint=now;}};
  const o=recallSchema.parse(raw),db=memoryDB(env),terms=queryTerms(o.query),at=new Date(o.as_of||Date.now()).toISOString();
  const allTokens=candidateTerms(terms).sort((a,b)=>b.weight-a.weight);
  const tokens=allTokens.slice(0,recallLimits.sqlTokens),scoreText=compileRelevance(terms);
  const candidateLimit=Math.min(recallLimits.candidatesPerStore,Math.max(16,o.limit*4),Math.max(16,Math.floor(recallLimits.candidateTokenBudget/Math.max(1,tokens.length)))),cap=candidateLimit+1;
  const previewChars=/\bphase \d+\b/.test(terms.exact[0]||'')?recallLimits.notePreviewChars:0;
  mark('expand_compile',tokens.length);
  const match=(column:string,lowered=false)=>{const text=lowered?column:`lower(${column})`;return `(CASE WHEN json_extract(value,'$.boundary') THEN (' '||${text}||' ') GLOB ('*[^a-z0-9]'||json_extract(value,'$.term')||'[^a-z0-9]*') ELSE instr(${text},json_extract(value,'$.term'))>0 END)`;};
  const lexical=(body:string,title:string,summary?:string)=>`(SELECT COALESCE(SUM((CASE WHEN ${match(title)} THEN 4 ${summary?`WHEN ${match(summary)} THEN 2`:''} ELSE 1 END)*json_extract(value,'$.weight')),0) FROM json_each(?) WHERE ${match(body)} OR ${match(title)})`;
  const time=(column:string)=>`${column}>=? AND ${column}<=?`;
  const from=o.from?new Date(o.from).toISOString():'',to=o.to?new Date(o.to).toISOString():'9999';
  const current=o.mode==='current';
  const memoryCurrent=`json_extract(m.payload,'$.valid_from')<=? AND (json_extract(m.payload,'$.valid_until') IS NULL OR json_extract(m.payload,'$.valid_until')>?) AND NOT EXISTS (SELECT 1 FROM personal_memory c WHERE c.vault=m.vault AND c.supersedes=m.memory_id AND json_extract(c.payload,'$.valid_from')<=?)`;
  const memory=await db.prepare(`SELECT m.*,${lexical("json_extract(m.payload,'$.summary')||' '||json_extract(m.payload,'$.context')",'m.topic',"json_extract(m.payload,'$.summary')")} AS lexical FROM personal_memory m WHERE m.vault=? AND ${time('m.occurred_at')}
    AND (?='[]' OR m.topic IN (SELECT value FROM json_each(?))) AND (?='[]' OR m.type IN (SELECT value FROM json_each(?))) ${current?'AND '+memoryCurrent:''}
    AND lexical>0 ORDER BY lexical DESC,m.memory_id LIMIT ${cap}`).bind(JSON.stringify(tokens),env.WEBDAV_ROOT,from,to,JSON.stringify(o.topics||[]),JSON.stringify(o.topics||[]),JSON.stringify(o.types||[]),JSON.stringify(o.types||[]),...(current?[at,at,at]:[])).all<MemoryRow>();
  mark('memory_sql',memory.results.length);
  const activity= o.types?.length ? {results:[]} : await db.prepare(`SELECT a.*,${lexical("json_extract(a.payload,'$.summary')||' '||json_extract(a.payload,'$.details')","a.project||' '||json_extract(a.payload,'$.task_name')||' '||json_extract(a.payload,'$.project_name')","json_extract(a.payload,'$.summary')")} AS lexical FROM shared_activity a WHERE a.vault=? AND ${time('a.occurred_at')}
    AND (?='[]' OR a.project IN (SELECT value FROM json_each(?))) ${current?`AND a.occurred_at<=? AND NOT EXISTS (SELECT 1 FROM shared_activity c WHERE c.vault=a.vault AND json_extract(c.payload,'$.supersedes')=a.event_id AND c.occurred_at<=?) AND NOT EXISTS (SELECT 1 FROM shared_activity n WHERE n.vault=a.vault AND n.project=a.project AND n.task_id=a.task_id AND n.occurred_at<=? AND json_extract(n.payload,'$.evidence') IN ('user_statement','observed_action') AND (n.occurred_at>a.occurred_at OR (n.occurred_at=a.occurred_at AND n.event_id>a.event_id)))`:''}
    AND lexical>0 ORDER BY lexical DESC,a.event_id LIMIT ${cap}`).bind(JSON.stringify(tokens),env.WEBDAV_ROOT,from,to,JSON.stringify(o.topics||[]),JSON.stringify(o.topics||[]),...(current?[at,at,at]:[])).all<{payload:string;event_id:string;occurred_at:string;recorded_at:string;vault_synced:number;project:string;task_id:string}>();
  mark('activity_sql',activity.results.length);
  const freshness=await indexStatus(env),root=freshness.root;
  mark('freshness_sql',2);
  // D1 scans indexed text; Worker receives only bounded previews and matched terms.
  // Materialize once: SQLite otherwise repeats the correlated lexical expression in WHERE/ORDER BY.
  // json_each also has a "path" column: always qualify the note path in correlated subqueries.
  const noteMatch=match("CASE WHEN notes.lower_content='' THEN lower(notes.content) ELSE notes.lower_content END",true)+' OR '+match('notes.path');
  const notes = root!==env.WEBDAV_ROOT || o.types?.length ? {results:[]} : await db.prepare(`WITH candidates AS MATERIALIZED (
    SELECT path,modified,indexed_at,substr(content,1,${previewChars}) ${previewChars?`|| ' ' || CASE WHEN instr(lower_content,'phase')>0 THEN substr(content,instr(lower_content,'phase'),20) ELSE '' END || ' ' || CASE WHEN instr(lower_content,'stage')>0 THEN substr(content,instr(lower_content,'stage'),20) ELSE '' END`:''} AS preview,
    (SELECT json_object('score',COALESCE(SUM((CASE WHEN ${match('notes.path')} THEN 16 ELSE 1 END)*json_extract(value,'$.weight')),0),
      'matched',COALESCE(group_concat(json_extract(value,'$.term'),char(10)),'')) FROM json_each(?) WHERE ${noteMatch}) AS evidence
    FROM notes WHERE ${time("COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',modified),indexed_at)")}
    AND (?='[]' OR EXISTS (SELECT 1 FROM json_each(?) WHERE instr(lower(notes.path),value)>0 OR instr(lower(notes.content),value)>0))
    AND NOT (path='Agent共享/最近动态.md' OR path LIKE 'Agent共享/活动记录/%' OR path LIKE 'Agent共享/项目/%' OR path LIKE 'Agent共享/个人记忆/事件/%' OR path LIKE 'Agent共享/个人记忆/主题/%')
    ) SELECT path,modified,indexed_at,preview,json_extract(evidence,'$.matched') AS matched,json_extract(evidence,'$.score') AS lexical
    FROM candidates WHERE lexical>0 ORDER BY lexical DESC,path LIMIT ${cap}`).bind(JSON.stringify(tokens),from,to,JSON.stringify(o.topics||[]),JSON.stringify(o.topics||[])).all<{path:string;preview:string;matched:string;modified:string|null;indexed_at:string}>();
  mark('notes_sql',notes.results.length);
  type Hit={kind:string;id:string;topic:string;type:string;summary:string;score:number;source:ReturnType<typeof sourceReference>;occurred_at:string|null;recorded_at:string|null;evidence:string;stance:string;vault_synced:boolean|null;indexed_at:string|null;conflict:boolean;revision?:number;source_refs?:string[];context?:string;context_source?:ReturnType<typeof sourceReference>};
  const hits:Hit[]=[];
  const heads=memory.results.length?await db.prepare(`SELECT m.topic,m.type,COUNT(*) AS n FROM personal_memory m WHERE m.vault=? AND ${memoryCurrent} GROUP BY m.topic,m.type`).bind(env.WEBDAV_ROOT,at,at,at).all<{topic:string;type:string;n:number}>():{results:[]};
  mark('heads_sql',heads.results.length);
  for(const r of memory.results.slice(0,candidateLimit)){
    const v=publicMemory(r),base=scoreText(v.summary+' '+v.context,v.topic);if(!base)continue;
    const score=base+scoreText(v.summary,v.topic);
    const lines=renderMemory(r).replace(/\r\n?/g,'\n').split('\n'),line=lines.indexOf('## Summary')+3;
    const conflicting=heads.results.find(h=>h.topic===v.topic&&h.type===v.type);
    const contextLine=lines.indexOf('## Context',line)+3;
    hits.push({kind:'memory',id:v.memory_id,topic:v.topic,type:v.type,summary:v.summary,score,source:sourceReference(v.path,line,line),occurred_at:v.occurred_at,recorded_at:v.recorded_at,evidence:v.evidence,stance:v.stance,vault_synced:v.vault_synced,indexed_at:null,conflict:(conflicting?.n||0)>1,revision:v.revision,source_refs:v.source_refs,
      ...(o.detail==='context'?{context:v.context,...(v.context?{context_source:sourceReference(v.path,contextLine,contextLine+v.context.replace(/\r\n?/g,'\n').split('\n').length-1)}:{})}:{})});
  }
  for(const r of activity.results.slice(0,candidateLimit)){const v=JSON.parse(r.payload),title=r.project+' '+v.task_name+' '+v.project_name,base=scoreText(v.summary+' '+v.details,title);if(!base)continue;
    const score=base+scoreText(v.summary,title);
    // Activity renderer places summary after the progress heading; correction adds one metadata line.
    const lines=renderEvent(v,r.recorded_at).split('\n'),line=lines.indexOf('## 进展')+3;
    hits.push({kind:'activity',id:r.event_id,topic:r.project,type:'activity',summary:v.summary,score,source:sourceReference(activityPath(r.event_id),line,line),occurred_at:r.occurred_at,recorded_at:r.recorded_at,evidence:v.evidence,stance:v.status,vault_synced:!!r.vault_synced,indexed_at:null,conflict:false,source_refs:v.sources});}
  const noteHeads=notes.results.map(n=>normalizeRecallText(n.path));
  const titleGrams=terms.grams.map(term=>({term,weight:100/(1+noteHeads.filter(head=>head.includes(term)).length)}));
  for(const [i,n] of notes.results.slice(0,candidateLimit).entries()){
    const body=normalizeRecallText(n.preview+'\n'+n.matched);
    const base=scoreText.normalized(body,noteHeads[i]);if(!base)continue;
    // Rare title/entity grams distinguish a destination or subject from broad diary coverage.
    const score=base+titleGrams.reduce((sum,g)=>sum+(noteHeads[i].includes(g.term)?g.weight:0),0);
    hits.push({kind:'note',id:n.path,topic:n.path,type:'note',summary:'',score,source:sourceReference(n.path,1,1),occurred_at:n.modified,recorded_at:null,evidence:'source_note',stance:'unclassified',vault_synced:null,indexed_at:n.indexed_at,conflict:false});
  }
  mark('score_candidates',hits.length);
  hits.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const seen=new Set<string>();
  // Capture already deduplicates identical personal evidence. Distinct immutable memories
  // may share a summary while retaining different situations or revisions.
  const unique=hits.filter(h=>{const key=JSON.stringify(h.kind==='memory'?[h.kind,h.id]:[h.kind,h.topic,h.summary]);if(seen.has(key))return false;seen.add(key);return true;});
  mark('sort_dedup',unique.length);
  // Fetch a single attributable line only for emitted notes. No whole-note transfer or per-line reranking.
  const selected=unique.slice(0,o.limit),paths=selected.filter(h=>h.kind==='note').map(h=>h.id);
  let sourceChanged=false;
  if(paths.length){
    const versions=selected.filter(h=>h.kind==='note').map(h=>({path:h.id,indexed_at:h.indexed_at}));
    const excerpts=await db.prepare(`WITH normalized AS MATERIALIZED (
      SELECT notes.path,replace(replace(notes.content,char(13)||char(10),char(10)),char(13),char(10)) AS text
      FROM json_each(?) v JOIN notes ON notes.path=json_extract(v.value,'$.path') AND notes.indexed_at=json_extract(v.value,'$.indexed_at')
      ), located AS MATERIALIZED (
      SELECT path,text,
      COALESCE((SELECT location FROM (SELECT instr(lower(text),json_extract(value,'$.term')) AS location,
        CASE WHEN instr(lower(normalized.path),json_extract(value,'$.term'))>0 THEN 1 ELSE 0 END AS in_title,
        json_extract(value,'$.weight') AS weight,length(json_extract(value,'$.term')) AS size FROM json_each(?) WHERE instr(lower(text),json_extract(value,'$.term'))>0)
        ORDER BY in_title DESC,weight DESC,size DESC LIMIT 1),1) AS pos
      FROM normalized)
      SELECT path,1+length(substr(text,1,pos-1))-length(replace(substr(text,1,pos-1),char(10),'')) AS line,
        substr(substr(text,pos,${recallLimits.excerptChars}),1,CASE WHEN instr(substr(text,pos,${recallLimits.excerptChars}),char(10))>0 THEN instr(substr(text,pos,${recallLimits.excerptChars}),char(10))-1 ELSE ${recallLimits.excerptChars} END) AS excerpt FROM located`)
      .bind(JSON.stringify(versions),JSON.stringify(tokens)).all<{path:string;line:number;excerpt:string}>();
    for(const row of excerpts.results){const hit=selected.find(h=>h.kind==='note'&&h.id===row.path)!;hit.summary=row.excerpt;hit.source=sourceReference(row.path,row.line,row.line);}
    const read=new Set(excerpts.results.map(r=>r.path));
    for(let i=selected.length-1;i>=0;i--)if(selected[i].kind==='note'&&!read.has(selected[i].id)){selected.splice(i,1);sourceChanged=true;}
  }
  mark('excerpt_sql',paths.length);
  const viewConflicts=await db.prepare("SELECT topic,sync_error FROM memory_views WHERE vault=? AND sync_error IS NOT NULL AND (?='[]' OR topic IN (SELECT value FROM json_each(?))) LIMIT 20").bind(env.WEBDAV_ROOT,JSON.stringify(o.topics||[]),JSON.stringify(o.topics||[])).all();
  mark('view_conflicts_sql',viewConflicts.results.length);
  const stale=!freshness.lastFullScanAt||Date.now()-Date.parse(freshness.lastFullScanAt)>15*60000||!freshness.sync?.complete;
  return {query:o.query,mode:o.mode,detail:o.detail,as_of:at,matches:selected,insufficient_evidence:selected.length===0,
    conflicts:unique.some(h=>h.conflict),view_conflicts:viewConflicts.results,candidate_truncated:sourceChanged||allTokens.length>tokens.length||[memory,activity,notes].some(s=>s.results.length===cap),
    freshness:{notes: freshness,notes_stale:stale,notes_root_matches:root===env.WEBDAV_ROOT,memory_activity:'Live D1 submitted records; independent of note index. Pending vault files are not live citations.'},
    coverage:'Only submitted memories/activities and indexed permitted Markdown. Unseen chats are not collected. No match is insufficient evidence, not proof of no history. Types filters select personal-memory types; topics filter stable Memory topics, Activity projects and note text/path. Notes are unclassified evidence, never automatically current facts.',
    instruction:'Attribute proposals/inferences. Conflicting heads require clarification, not silent selection. Verify indexed or edited sources with read_context; pending vault files may not exist. Timeline preserves superseded evidence. Lexical matching has limited paraphrase coverage.'};
}
