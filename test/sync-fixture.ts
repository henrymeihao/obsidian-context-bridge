import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function syncFixture(filename=':memory:') {
  const sql=new DatabaseSync(filename);
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  sql.prepare("INSERT OR IGNORE INTO index_meta VALUES('root','fixture')").run();
  const db={prepare(query:string){let args:any[]=[];const stmt={bind(...values:any[]){args=values;return stmt;},async run(){return sql.prepare(query).run(...args);},async first(column?:string){const r=sql.prepare(query).get(...args) as any;return column?r?.[column]??null:r??null;},async all(){return {results:sql.prepare(query).all(...args)};}};return stmt;}} as unknown as D1Database;
  const env={SEARCH_DB:db,ACCESS_MODE:'vault',WEBDAV_ROOT:'fixture',ALLOWED_NOTES:'',WEBDAV_USERNAME:'fixture',WEBDAV_PASSWORD:'fixture'};
  return {sql,env,seed(path:string,text='preserve'){sql.prepare('INSERT OR REPLACE INTO notes VALUES(?,?,?,?,?,?,?,?)').run(path,text,text.toLowerCase(),Buffer.byteLength(text),null,'1','2026-01-01T00:00:00Z','previous');},state(){return JSON.parse(sql.prepare("SELECT value FROM index_meta WHERE key='sync_state'").get()!.value as string);},retryNow(){const s=this.state();for(const r of Object.values(s.retries||{}) as any[])r.after=0;for(const r of s.sweepQueue||[])r.after=0;sql.prepare("UPDATE index_meta SET value=? WHERE key='sync_state'").run(JSON.stringify(s));}};
}
export function directory(notes:string[]=[],folders:string[]=[],padding=0) {
  const response=(path:string,dir=false)=>`<response><href>/dav/fixture/${encodeURI(path)}${dir?'/':''}</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype>${dir?'<collection/>':''}</resourcetype><getetag>1</getetag></prop></propstat></response>`;
  return new Response(`<multistatus xmlns="DAV:"><response><href>/dav/fixture/</href></response>${notes.map(p=>response(p)).join('')}${folders.map(p=>response(p,true)).join('')}${'<response/>'.repeat(padding)}</multistatus>`,{status:207});
}
