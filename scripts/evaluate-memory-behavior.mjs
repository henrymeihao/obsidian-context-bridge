// Opt-in: real Codex model/tool selection against an isolated in-process SQLite/WebDAV fixture.
// Usage: node scripts/evaluate-memory-behavior.mjs [chatgpt|codex] [decision|exploration|duplicate|project]
import {readFile,writeFile,mkdir,copyFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
const [client='codex',scenario='decision']=process.argv.slice(2);
const prompts={
 decision:'我已经决定，明年把职业方向从后端开发转到产品设计，先参加一个系统课程，再用小项目验证。这是我认真比较后确定的方向。你觉得我该留意哪些风险？',
 exploration:'我还在比较继续写代码和做产品设计，两边都没想清楚，也没有得出新的结论。今天先帮我列出各自要考虑的因素，不要替我下决定。',
 duplicate:'我还是和以前一样，长期偏好先给简短结论，再按需展开细节。这点没有变化。你觉得这样沟通有什么取舍？',
 project:'atlas-demo 项目的分页接口已完成本地开发，12项测试通过，但尚未部署。请根据这个进展说一下下一步该检查什么。',
 insight:'经过刚才的比较，我现在对 AI 辅助判断形成了一个结论：它适合帮我展开候选和找反例，但最终的价值取舍仍应由我来承担。以后评估 AI 的作用时，我会用这个区分。你觉得这个结论还有什么边界？',
 paraphrase:'我们之前关于让机器列选项、人来做价值取舍的结论是什么？请核对原始依据；找不到就说不知道。'
};
if(!['chatgpt','codex'].includes(client)||!prompts[scenario])throw new Error('Unknown client/scenario');
const repo=resolve(import.meta.dirname,'..'),dir=resolve(repo,'work/phase4a/behavior',client,scenario),home=resolve(dir,'.eval-home');
await mkdir(dir,{recursive:true});await mkdir(home,{recursive:true});
// Preserve previous attempts; each run's tool log must describe only that run.
let previous=false;try{await readFile(resolve(dir,'result.json'));previous=true;}catch{}
if(previous){const archive=resolve(dir,'previous',String(Date.now()));await mkdir(archive,{recursive:true});
 for(const name of ['result.json','agent.jsonl','stderr.txt','calls.jsonl','state.json'])try{await copyFile(resolve(dir,name),resolve(archive,name));}catch{}
}
await writeFile(resolve(dir,'calls.jsonl'),'');
// Auth is used only for the model API; no production MCP/Worker configuration is copied.
await copyFile(resolve(process.env.CODEX_HOME||resolve(homedir(),'.codex'),'auth.json'),resolve(home,'auth.json'));
const skillDir=resolve(dir,'.agents/skills/sync-shared-context');await mkdir(skillDir,{recursive:true});
await copyFile(resolve(repo,'skills',client,'sync-shared-context/SKILL.md'),resolve(skillDir,'SKILL.md'));
await writeFile(resolve(dir,'AGENTS.md'),'这是独立的虚构测试人物环境，所有用户陈述和已有记录都属于虚构人物，不是真实用户资料。部署者已授权本环境在当前对话中提取普通、非敏感且有明确证据的重要个人结论，以及项目活动；授权引用为 fixture:owner-authorization。不得保存敏感/第三方资料或聊天全文。仅使用本环境已配置的隔离工具，禁止连接生产服务。\n');
await writeFile(resolve(dir,'prompt.txt'),prompts[scenario]);
const config={command:process.execPath,args:['--import','tsx',resolve(repo,'test/behavior-server.ts')],cwd:repo,env:{BEHAVIOR_OUTPUT:dir,BEHAVIOR_CASE:scenario}};
const tomlString=x=>JSON.stringify(x.replaceAll('\\','/'));
const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--disable','apps','--json','-C',dir,
 '-c',`mcp_servers.fixture.command=${tomlString(config.command)}`,
 '-c',`mcp_servers.fixture.args=${JSON.stringify(config.args.map(x=>x.replaceAll('\\','/')))}`,
 '-c',`mcp_servers.fixture.cwd=${tomlString(repo)}`,
 '-c',`mcp_servers.fixture.env={ BEHAVIOR_OUTPUT=${tomlString(dir)}, BEHAVIOR_CASE=${JSON.stringify(scenario)} }`];
// Approve ONLY this explicitly authorized fixture's tools; never change a production/app setting.
for(const tool of ['read_skill','read_context','recall_memory','get_activity_context','capture_memory','append_activity'])args.push('-c',`mcp_servers.fixture.tools.${tool}.approval_mode="approve"`);
args.push('-');
const proc=spawn(process.env.CODEX_BIN||'codex',args,{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe'],shell:false});
let out='',err='';proc.stdout.on('data',d=>{out+=d;});proc.stderr.on('data',d=>{err+=d;});proc.stdin.end(prompts[scenario]);
const timer=setTimeout(()=>proc.kill(),240000);
let code;
try{code=await new Promise((res,rej)=>{proc.on('error',rej);proc.on('close',res);});}
finally{clearTimeout(timer);await unlink(resolve(home,'auth.json')).catch(()=>{});}
await writeFile(resolve(dir,'agent.jsonl'),out);await writeFile(resolve(dir,'stderr.txt'),err);
let state,calls=[];try{state=JSON.parse(await readFile(resolve(dir,'state.json'),'utf8'));calls=(await readFile(resolve(dir,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
const writes=calls.filter(c=>['capture_memory','append_activity'].includes(c.tool));
const evidence=state?.memories[0]?JSON.parse(state.memories[0].payload):null;
const recallBeforeCapture=calls.findIndex(c=>c.tool==='recall_memory')>=0&&calls.findIndex(c=>c.tool==='recall_memory')<calls.findIndex(c=>c.tool==='capture_memory');
const passed=code===0&&!!state&&!calls.some(c=>c.error)&&(
 ['decision','insight'].includes(scenario)?state.memories.length===1&&recallBeforeCapture&&evidence.type===(scenario==='decision'?'decision':'exploration')&&evidence.evidence==='user_statement'&&evidence.stance==='confirmed'&&writes.some(c=>c.tool==='capture_memory'&&c.result.vault_synced)&&!writes.some(c=>c.tool==='append_activity'):
 scenario==='project'?state.memories.length===0&&state.activities.length===1&&JSON.parse(state.activities[0].payload).evidence==='user_statement'&&writes.every(c=>c.tool==='append_activity'):
 scenario==='duplicate'?state.memories.length===1&&writes.length===0&&calls.some(c=>c.tool==='recall_memory'):
 scenario==='paraphrase'?state.memories.length===1&&writes.length===0&&calls.some(c=>c.tool==='recall_memory'&&c.result.matches?.some(h=>h.id==='fixture_ai_language')):
 state.memories.length===0&&state.activities.length===0&&writes.length===0);
const result={client_skill:client,runtime:'actual Codex CLI; NOT ChatGPT frontend',scenario,code,passed,calls:calls.map(c=>c.tool),memory_count:state?.memories.length,activity_count:state?.activities.length};
await writeFile(resolve(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
process.exitCode=passed?0:1;
