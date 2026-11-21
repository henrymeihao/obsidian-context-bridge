// Opt-in model evaluation MCP. No production credentials, HTTP transport or external WebDAV.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {fixture} from './activity-fixture.js';
import {captureMemory,memorySchema,MEMORY_SCOPE} from '../src/memory.js';
import {recallMemory,recallSchema} from '../src/recall.js';
import {appendActivity,activitySchema,getActivityContext} from '../src/activity.js';
const dir=process.env.BEHAVIOR_OUTPUT;
if(!dir)throw new Error('BEHAVIOR_OUTPUT must name an isolated evaluation directory');
const f=fixture();f.sql.prepare("INSERT INTO index_meta VALUES('root','fixture')").run();
const seed={memory_id:'fixture_existing_pref',topic:'answer-style',type:'preference',summary:'用户长期偏好先给简短结论，再按需展开细节。',agent:'fixture',session_ref:'fixture:previous-conversation',source_refs:['fixture:previous-user-statement'],evidence:'user_statement',stance:'confirmed',occurred_at:'2026-01-01T00:00:00Z',valid_from:'2026-01-01T00:00:00Z',authorization_ref:'fixture:owner-authorization'};
if(process.env.BEHAVIOR_CASE==='duplicate')await captureMemory(f.env,seed,[MEMORY_SCOPE],f.fetcher);
if(process.env.BEHAVIOR_CASE==='paraphrase')await captureMemory(f.env,{...seed,memory_id:'fixture_ai_language',topic:'model-judgment',type:'exploration',summary:'AI should offer candidates and counterexamples, while humans retain final value judgment.'},[MEMORY_SCOPE],f.fetcher);
const snapshot=()=>writeFileSync(dir+'/state.json',JSON.stringify({memories:f.sql.prepare('SELECT memory_id,topic,type,payload,revision FROM personal_memory').all(),activities:f.sql.prepare('SELECT event_id,payload FROM shared_activity').all(),files:[...f.files].map(([path,v])=>({path,text:v.text})),puts:f.puts},null,2));
snapshot();
const server=new McpServer({name:'isolated-memory-evaluation',version:'1.0.0'}, {instructions:'This server is a fictional isolated vault for evaluating the installed Skill. No production data is accessible.'});
function record(name:string,action:(args:any)=>Promise<unknown>){return async(args:any)=>{
 try{const result=await action(args);appendFileSync(dir+'/calls.jsonl',JSON.stringify({tool:name,args,result})+'\n');snapshot();return {content:[{type:'text' as const,text:JSON.stringify(result)}]};}
 catch(error){const message=String(error);appendFileSync(dir+'/calls.jsonl',JSON.stringify({tool:name,args,error:message})+'\n');return {isError:true,content:[{type:'text' as const,text:message}]};}
};}
server.registerTool('recall_memory',{description:'Retrieve personal memory, project activity and indexed notes with sources.',inputSchema:recallSchema},record('recall_memory',a=>recallMemory(f.env,a)));
server.registerTool('capture_memory',{description:'Persist a personal memory. Requires authorized scope; only vault_synced=true verifies vault storage.',inputSchema:memorySchema},record('capture_memory',a=>captureMemory(f.env,a,[MEMORY_SCOPE],f.fetcher)));
server.registerTool('append_activity',{description:'Persist project activity. Only vault_synced=true verifies vault storage.',inputSchema:activitySchema},record('append_activity',a=>appendActivity(f.env,a,f.fetcher)));
server.registerTool('get_activity_context',{description:'Read submitted project activity.',inputSchema:z.object({project:z.string().optional(),days:z.number().optional(),limit:z.number().optional()})},record('get_activity_context',a=>getActivityContext(f.env,a)));
server.registerTool('read_context',{description:'Read an existing vault Markdown source.',inputSchema:z.object({path:z.string()})},record('read_context',async a=>{const text=f.files.get(a.path)?.text;if(!text)throw new Error('Note not found');return {path:a.path,text};}));
server.registerTool('read_skill',{description:'Read the locally installed sync-shared-context Skill instructions.',inputSchema:z.object({})},record('read_skill',async()=>({text:readFileSync(dir+'/.agents/skills/sync-shared-context/SKILL.md','utf8')})));
await server.connect(new StdioServerTransport());
