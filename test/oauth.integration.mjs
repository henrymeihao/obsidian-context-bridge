// Isolated protocol integration: in-memory OAuth KV and synthetic WebDAV only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
registerHooks({
 resolve(s,c,next) { return s === 'cloudflare:workers' ? {url:s,shortCircuit:true} : next(s,c); },
 load(u,c,next) { return u === 'cloudflare:workers' ? {format:'module',source:'export class WorkerEntrypoint {}',shortCircuit:true} : next(u,c); }
});
const {default:worker} = await import('../src/index.ts');
test('fresh OAuth + PKCE + MCP read, scoped append and idempotent retry', async () => {
 const origin='https://bridge.example', data=new Map(), key=randomBytes(32).toString('base64url');
 const kv={
  async get(k,t) { const r=data.get(k); return r ? (t==='json'||t?.type==='json' ? JSON.parse(r.value) : r.value) : null; },
  async put(k,v,o) { data.set(k,{value:v,metadata:o?.metadata}); },
  async delete(k) { data.delete(k); },
  async list(o) { return {keys:[...data].filter(([k])=>k.startsWith(o?.prefix||'')).map(([name,r])=>({name,metadata:r.metadata})),list_complete:true,cursor:''}; }
 };
 const env={PUBLIC_ORIGIN:origin,OAUTH_KV:kv,WEBDAV_ROOT:'example',ALLOWED_NOTES:'测试.md,饮食记录.md',WEBDAV_USERNAME:'fixture',WEBDAV_PASSWORD:'fixture',OWNER_KEY_SHA256:createHash('sha256').update(key).digest('hex')};
 const ctx=()=>({waitUntil(){},passThroughOnException(){},props:{}});
 const request=(p,init={})=>worker.fetch(new Request(origin+p,init),env,ctx());
 assert.equal((await request('/mcp',{method:'POST'})).status,401);
 const discovery=await (await request('/.well-known/oauth-authorization-server')).json();
 assert.equal(discovery.authorization_endpoint,origin+'/authorize');
 const originalFetch=globalThis.fetch;
 let diet='# Example\n',version=1,puts=0;
 globalThis.fetch=async (url,init={})=>{
  const u=new URL(String(url));
  assert.equal(u.origin,'https://dav.jianguoyun.com','no real network allowed');
  const p=decodeURIComponent(u.pathname);
  assert.ok(['/dav/example/测试.md','/dav/example/饮食记录.md'].includes(p));
  if(init.method==='PUT') {
   assert.ok(p.endsWith('饮食记录.md'));
   assert.equal(init.headers['If-Match'],String(version));
   diet=new TextDecoder().decode(init.body);version++;puts++;
   return new Response(null,{status:204});
  }
  return new Response(p.endsWith('测试.md')?'# Test\nSynthetic note\n':diet,{headers:{etag:String(version)}});
 };
 try {
  const authorize=async scope=>{
   const registered=await request('/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'integration <test>',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
   assert.equal(registered.status,201);
   const client=await registered.json(), verifier=randomBytes(48).toString('base64url');
   const params=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.example/callback',response_type:'code',scope,state:'test-state',resource:origin+'/mcp',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
   const page=await request('/authorize?'+params), html=await page.text();
   assert.equal(page.status,200);assert.ok(!html.includes('integration <test>'));
   assert.equal(page.headers.get('referrer-policy'),'same-origin');
   assert.ok(page.headers.get('content-security-policy').includes('https://client.example/callback'));
   const handle=html.match(/name="handle" value="([^"]+)"/)[1];
   const cookie=page.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
   const post=(owner_key=key,site=origin)=>request('/authorize',{method:'POST',headers:{origin:site,cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,owner_key,decision:'approve'})});
   assert.equal((await post(key,'https://untrusted.example')).status,403);
   assert.equal((await post('wrong-key')).status,403);
   const approved=await post();assert.equal(approved.status,302,await approved.clone().text());
   assert.equal((await post()).status,400);
   const callback=new URL(approved.headers.get('location'));assert.equal(callback.searchParams.get('state'),'test-state');
   const response=await request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:callback.searchParams.get('code'),code_verifier:verifier,redirect_uri:'https://client.example/callback',resource:origin+'/mcp'})});
   assert.equal(response.status,200,await response.clone().text());
   return (await response.json()).access_token;
  };
  const rpc=async (token,method,params)=>{
   const res=await request('/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
   assert.equal(res.status,200,await res.clone().text());return res.json();
  };
  const token=await authorize('context:read');
  assert.equal((await rpc(token,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}})).result.serverInfo.name,'obsidian-context-bridge');
  const listed=await rpc(token,'tools/list',{});assert.ok(listed.result.tools.some(t=>t.name==='read_context'));
  const read=await rpc(token,'tools/call',{name:'read_context',arguments:{path:'测试.md'}});
  assert.ok(read.result.content[0].text.includes('Synthetic note'));
  const args={date:'2026-01-01',text:'Synthetic meal',record_id:'integration_001'};
  assert.equal((await rpc(token,'tools/call',{name:'append_diet_record',arguments:args})).result.isError,true);
  assert.equal(puts,0);
  const writer=await authorize('context:read context:append:diet');
  for(let i=0;i<2;i++) { const result=await rpc(writer,'tools/call',{name:'append_diet_record',arguments:args});assert.ok(!result.result.isError,JSON.stringify(result)); }
  assert.equal(puts,1);assert.ok(diet.includes('Synthetic meal'));
 } finally {globalThis.fetch=originalFetch;}
});