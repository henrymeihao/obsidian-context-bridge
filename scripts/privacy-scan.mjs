// Bounded release hygiene scan. Reports locations/categories, never matched values.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});
const rules=[
 ['machine-path',/(?:[A-Za-z]:[\\/](?:Users|home)[\\/]|\/(?:Users|home)\/[A-Za-z0-9_-]+\/)/],
 ['email',/[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
 ['private-key-or-token',/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}/],
 ['resource-id',/\b[a-f0-9]{32}\b/],
 ['deployment-url',/https:\/\/(?![^\s'"<>]*YOUR_SUBDOMAIN)[^\s'"<>]+\.workers\.dev/],
];
let findings=0,files=0,blobs=0;
function scan(text,location) {
 if(text.includes('\0'))return;
 for(const [i,line] of text.split(/\r?\n/).entries())for(const [category,rule] of rules)if(rule.test(line)){
  console.log(JSON.stringify({location,line:i+1,category}));findings++;
 }
}
for(const file of git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean)){
 try{scan(readFileSync(file,'utf8'),file);files++;}catch(error){if(error.code!=='ENOENT')throw error;}
}
if(process.argv.includes('--history')) {
 for(const row of git('rev-list','--objects','--all').trim().split('\n').filter(Boolean)){
  const [oid,...name]=row.split(' ');
  if(git('cat-file','-t',oid).trim()!=='blob')continue;
  scan(git('cat-file','blob',oid),`history:${oid.slice(0,12)}:${name.join(' ')}`);blobs++;
 }
}
console.log(JSON.stringify({files,history_blobs:blobs,findings,scope:'finite pattern scan; not a full security audit'}));
process.exitCode=findings?1:0;
