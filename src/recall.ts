import { z } from 'zod';
import { memoryDB, memoryTypes, publicMemory, renderMemory, type MemoryRow } from './memory.js';
import { activityPath, renderEvent } from './activity.js';
import { indexStatus, sourceReference, type SearchEnv } from './search.js';

export const recallSchema=z.object({query:z.string().trim().min(1).max(500),topics:z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/)).max(12).optional(),types:z.array(memoryTypes).max(6).optional(),
  from:z.string().datetime({offset:true}).optional(),to:z.string().datetime({offset:true}).optional(),
  mode:z.enum(['current','timeline']).default('current'),as_of:z.string().datetime({offset:true}).optional(),limit:z.number().int().min(1).max(50).default(10)}).strict()
  .refine(v=>!v.from||!v.to||Date.parse(v.from)<=Date.parse(v.to),'Invalid time range');
export type RecallOptions=z.input<typeof recallSchema>;
export {queryTerms,relevance} from './recall-query.js';
import {queryTerms,relevance,candidateTerms} from './recall-query.js';
export async function recallMemory(env:SearchEnv,raw:RecallOptions) {
  const o=recallSchema.parse(raw),db=memoryDB(env),terms=queryTerms(o.query),at=new Date(o.as_of||Date.now()).toISOString();
  const tokens=candidateTerms(terms);
  const match=(column:string)=>`(CASE WHEN json_extract(value,'$.boundary') THEN (' '||lower(${column})||' ') GLOB ('*[^a-z0-9]'||json_extract(value,'$.term')||'[^a-z0-9]*') ELSE instr(lower(${column}),json_extract(value,'$.term'))>0 END)`;
  const lexical=(body:string,title:string,summary?:string)=>`(SELECT COALESCE(SUM((CASE WHEN ${match(title)} THEN 4 ${summary?`WHEN ${match(summary)} THEN 2`:''} ELSE 1 END)*json_extract(value,'$.weight')),0) FROM json_each(?) WHERE ${match(body)} OR ${match(title)})`;
  const time=(column:string)=>`${column}>=? AND ${column}<=?`;
  const from=o.from?new Date(o.from).toISOString():'',to=o.to?new Date(o.to).toISOString():'9999';
  const current=o.mode==='current';
  const memoryCurrent=`json_extract(m.payload,'$.valid_from')<=? AND (json_extract(m.payload,'$.valid_until') IS NULL OR json_extract(m.payload,'$.valid_until')>?) AND NOT EXISTS (SELECT 1 FROM personal_memory c WHERE c.vault=m.vault AND c.supersedes=m.memory_id AND json_extract(c.payload,'$.valid_from')<=?)`;
  const memory=await db.prepare(`SELECT m.*,${lexical("json_extract(m.payload,'$.summary')||' '||json_extract(m.payload,'$.context')",'m.topic',"json_extract(m.payload,'$.summary')")} AS lexical FROM personal_memory m WHERE m.vault=? AND ${time('m.occurred_at')}
    AND (?='[]' OR m.topic IN (SELECT value FROM json_each(?))) AND (?='[]' OR m.type IN (SELECT value FROM json_each(?))) ${current?'AND '+memoryCurrent:''}
    AND lexical>0 ORDER BY lexical DESC,m.memory_id LIMIT 201`).bind(JSON.stringify(tokens),env.WEBDAV_ROOT,from,to,JSON.stringify(o.topics||[]),JSON.stringify(o.topics||[]),JSON.stringify(o.types||[]),JSON.stringify(o.types||[]),...(current?[at,at,at]:[])).all<MemoryRow>();
  const activity= o.types?.length ? {results:[]} : await db.prepare(`SELECT a.*,${lexical("json_extract(a.payload,'$.summary')||' '||json_extract(a.payload,'$.details')","a.project||' '||json_extract(a.payload,'$.task_name')||' '||json_extract(a.payload,'$.project_name')","json_extract(a.payload,'$.summary')")} AS lexical FROM shared_activity a WHERE a.vault=? AND ${time('a.occurred_at')}
    AND (?='[]' OR a.project IN (SELECT value FROM json_each(?))) ${current?`AND a.occurred_at<=? AND NOT EXISTS (SELECT 1 FROM shared_activity c WHERE c.vault=a.vault AND json_extract(c.payload,'$.supersedes')=a.event_id AND c.occurred_at<=?) AND NOT EXISTS (SELECT 1 FROM shared_activity n WHERE n.vault=a.vault AND n.project=a.project AND n.task_id=a.task_id AND n.occurred_at<=? AND json_extract(n.payload,'$.evidence') IN ('user_statement','observed_action') AND (n.occurred_at>a.occurred_at OR (n.occurred_at=a.occurred_at AND n.event_id>a.event_id)))`:''}
    AND lexical>0 ORDER BY lexical DESC,a.event_id LIMIT 201`).bind(JSON.stringify(tokens),env.WEBDAV_ROOT,from,to,JSON.stringify(o.topics||[]),JSON.stringify(o.topics||[]),...(current?[at,at,at]:[])).all<{payload:string;event_id:string;occurred_at:string;recorded_at:string;vault_synced:number;project:string;task_id:string}>();
  const root=await db.prepare("SELECT value FROM index_meta WHERE key='root'").first<string>('value');
  const notes = root!==env.WEBDAV_ROOT || o.types?.length ? {results:[]} : await db.prepare(`SELECT *,${lexical('content','path')} AS lexical FROM notes WHERE ${time("COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',modified),indexed_at)")}
    AND (?='[]' OR EXISTS (SELECT 1 FROM json_each(?) WHERE instr(lower(path),value)>0 OR instr(lower(content),value)>0))
    AND NOT (path='Agent共享/最近动态.md' OR path LIKE 'Agent共享/活动记录/%' OR path LIKE 'Agent共享/项目/%' OR path LIKE 'Agent共享/个人记忆/事件/%' OR path LIKE 'Agent共享/个人记忆/主题/%')
    AND lexical>0 ORDER BY lexical DESC,path LIMIT 201`).bind(JSON.stringify(tokens),from,to,JSON.stringify(o.topics||[]),JSON.stringify(o.topics||[])).all<{path:string;content:string;modified:string|null;indexed_at:string}>();
  type Hit={kind:string;id:string;topic:string;type:string;summary:string;score:number;source:ReturnType<typeof sourceReference>;occurred_at:string|null;recorded_at:string|null;evidence:string;stance:string;vault_synced:boolean|null;indexed_at:string|null;conflict:boolean;revision?:number;source_refs?:string[]};
  const hits:Hit[]=[];
  const heads=await db.prepare(`SELECT m.topic,m.type,COUNT(*) AS n FROM personal_memory m WHERE m.vault=? AND ${memoryCurrent} GROUP BY m.topic,m.type`).bind(env.WEBDAV_ROOT,at,at,at).all<{topic:string;type:string;n:number}>();
  for(const r of memory.results){
    const v=publicMemory(r),base=relevance(v.summary+' '+v.context,v.topic,terms);if(!base)continue;
    const score=base+relevance(v.summary,v.topic,terms);
    const lines=renderMemory(r).split('\n'),line=lines.indexOf('## Summary')+3;
    const conflicting=heads.results.find(h=>h.topic===v.topic&&h.type===v.type);
    hits.push({kind:'memory',id:v.memory_id,topic:v.topic,type:v.type,summary:v.summary,score,source:sourceReference(v.path,line,line),occurred_at:v.occurred_at,recorded_at:v.recorded_at,evidence:v.evidence,stance:v.stance,vault_synced:v.vault_synced,indexed_at:null,conflict:(conflicting?.n||0)>1,revision:v.revision,source_refs:v.source_refs});
  }
  for(const r of activity.results){const v=JSON.parse(r.payload),title=r.project+' '+v.task_name+' '+v.project_name,base=relevance(v.summary+' '+v.details,title,terms);if(!base)continue;
    const score=base+relevance(v.summary,title,terms);
    // Activity renderer places summary after the progress heading; correction adds one metadata line.
    const lines=renderEvent(v,r.recorded_at).split('\n'),line=lines.indexOf('## 进展')+3;
    hits.push({kind:'activity',id:r.event_id,topic:r.project,type:'activity',summary:v.summary,score,source:sourceReference(activityPath(r.event_id),line,line),occurred_at:r.occurred_at,recorded_at:r.recorded_at,evidence:v.evidence,stance:v.status,vault_synced:!!r.vault_synced,indexed_at:null,conflict:false,source_refs:v.sources});}
  for(const n of notes.results){
    if(o.topics?.length&&!o.topics.some(t=>n.path.toLowerCase().includes(t)||n.content.toLowerCase().includes(t)))continue;
    const score=relevance(n.content,n.path,terms);if(!score)continue;
    const lines=n.content.replace(/\r\n?/g,'\n').split('\n');let best=0,bestScore=-1;
    for(let i=0;i<lines.length;i++){const s=relevance(lines[i],'',terms);if(s>bestScore){bestScore=s;best=i;}}
    hits.push({kind:'note',id:n.path,topic:n.path,type:'note',summary:lines[best].slice(0,1000),score,source:sourceReference(n.path,best+1,best+1),occurred_at:n.modified,recorded_at:null,evidence:'source_note',stance:'unclassified',vault_synced:null,indexed_at:n.indexed_at,conflict:false});
  }
  hits.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const unique=hits.filter((h,i)=>!hits.slice(0,i).some(p=>p.kind===h.kind&&p.topic===h.topic&&p.summary===h.summary));
  const freshness=await indexStatus(env);
  const viewConflicts=await db.prepare("SELECT topic,sync_error FROM memory_views WHERE vault=? AND sync_error IS NOT NULL AND (?='[]' OR topic IN (SELECT value FROM json_each(?))) LIMIT 20").bind(env.WEBDAV_ROOT,JSON.stringify(o.topics||[]),JSON.stringify(o.topics||[])).all();
  const stale=!freshness.lastFullScanAt||Date.now()-Date.parse(freshness.lastFullScanAt)>15*60000||!freshness.sync?.complete;
  return {query:o.query,mode:o.mode,as_of:at,matches:unique.slice(0,o.limit),insufficient_evidence:unique.length===0,
    conflicts:unique.some(h=>h.conflict),view_conflicts:viewConflicts.results,candidate_truncated:[memory,activity,notes].some(s=>s.results.length===201),
    freshness:{notes: freshness,notes_stale:stale,notes_root_matches:root===env.WEBDAV_ROOT,memory_activity:'Live D1 submitted records; independent of note index. Pending vault files are not live citations.'},
    coverage:'Only submitted memories/activities and indexed permitted Markdown. Unseen chats are not collected. No match is insufficient evidence, not proof of no history. Types filters select personal-memory types; topics filter stable Memory topics, Activity projects and note text/path. Notes are unclassified evidence, never automatically current facts.',
    instruction:'Attribute proposals/inferences. Conflicting heads require clarification, not silent selection. Verify indexed or edited sources with read_context; pending vault files may not exist. Timeline preserves superseded evidence. Lexical matching has limited paraphrase coverage.'};
}
