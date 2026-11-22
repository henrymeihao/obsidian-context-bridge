// Bounded lexical concepts, not a translator or aliases attached to a person's records.
// Expand both directions; score a concept once so correlated synonyms cannot flood ranking.
const concepts = [
  ['职业转型','转行','换职业','career change','career transition'],
  ['职业规划','职业目标','career planning','career goals'],
  ['旅行','旅游','出游','travel','trip'],
  ['人工智能','ai','artificial intelligence'],
  ['偏好','喜欢','preference','prefer'],
  ['计划','打算','plan','planning'],
  ['决定','决策','decision','decided'],
  ['客户端','client'],
  ['连通性','联通性','连接','connectivity','connection'],
  ['测试','验证','验收','test','testing','verification','acceptance'],
  ['记忆','memory','memories'],
  ['项目','project'],
  ['远程办公','远程工作','remote work','working remotely'],
  ['徒步','远足','hiking','hike','trekking'],
  ['写作','writing'],
  ['学习','learning','study'],
  ['判断','judgment','judgement'],
] as const;
const stopWords=new Set(['the','and','for','with','about','what','was','is','my','of','to','in','on','a','an']);
const genericConcepts=new Set(['偏好','计划','决定','客户端','测试','记忆','项目']);
const genericWords=new Set<string>(concepts.filter(g=>genericConcepts.has(g[0])).flat());
function chineseNumber(s:string):number {
  if(/^\d+$/.test(s))return Number(s);
  const digits='零一二三四五六七八九';
  if(s==='两')return 2;
  if(s.includes('十')){const [a,b]=s.split('十');return (a?digits.indexOf(a):1)*10+(b?digits.indexOf(b):0);}
  return digits.indexOf(s);
}
export function normalizeRecallText(text:string):string {
  return text.normalize('NFKC').toLowerCase().replace(/[_\-–—]+/g,' ')
    .replace(/第([零一二三四五六七八九十两\d]{1,3})(?:个)?阶段/g,(_,n)=>` phase ${chineseNumber(n)} `)
    .replace(/\b(?:phase|stage)\s*(\d+)\b/g,'phase $1').replace(/\s+/g,' ').trim();
}
function hasPhrase(text:string,phrase:string):boolean {
  if(/[\p{Script=Han}]/u.test(phrase))return text.includes(phrase);
  const escaped=phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`,'u').test(text);
}
export function queryTerms(query:string) {
  const normalized=normalizeRecallText(query),surface=query.normalize('NFKC').toLowerCase();
  const exact=new Set<string>([normalized,surface].filter(Boolean));
  for(const word of normalized.match(/[a-z0-9]+|[\p{Script=Han}]+/gu)||[])
    if(word.length>1&&!stopWords.has(word))exact.add(word);
  const groups:string[][]=concepts.filter(g=>g.some(w=>hasPhrase(normalized,w))).map(g=>[...g]);
  for(const m of normalized.matchAll(/\bphase (\d+)\b/g)) {
    // Include original SQL spellings: scoring normalizes later, SQLite has no NFKC tokenizer.
    const n=Number(m[1]);
    const chinese=n<10?'零一二三四五六七八九'[n]:n<20?'十'+(n%10?'零一二三四五六七八九'[n%10]:''):n<100?'零一二三四五六七八九'[Math.floor(n/10)]+'十'+(n%10?'零一二三四五六七八九'[n%10]:''):String(n);
    groups.push([`phase ${n}`,`phase-${n}`,`phase${n}`,`stage ${n}`,`stage-${n}`,`第${chinese}阶段`,`第${n}阶段`]);
    exact.add(`phase ${n}`);
  }
  const expanded=[...new Set(groups.flat())].filter(s=>!exact.has(s));
  const grams=new Set<string>();
  for(const run of normalized.match(/[\p{Script=Han}]+/gu)||[])for(let i=0;i<run.length-1;i++)grams.add(run.slice(i,i+2));
  return {exact:[...exact].slice(0,40),expanded:expanded.slice(0,100),groups,
    grams:[...grams].filter(s=>!exact.has(s)).slice(0,40)};
}
export function candidateTerms(terms:ReturnType<typeof queryTerms>) {
  const weights=new Map<string,number>();
  for(const [words,weight] of [[terms.grams,1],[terms.expanded,2],[terms.exact,8]] as const)
    for(const term of words){weights.set(term,weight);
      // Fullwidth ASCII source text must reach the candidate set before JS NFKC scoring.
      if(/^[\x20-\x7e]+$/.test(term))for(const spelling of [term,term.toUpperCase()])
        weights.set(spelling.replace(/[!-~]/g,c=>String.fromCharCode(c.charCodeAt(0)+0xfee0)),weight);
    }
  return [...weights].map(([term,weight])=>({term,weight,boundary:/^[a-z][a-z0-9]*$/.test(term)}));
}
export function relevance(text:string,title:string,terms:ReturnType<typeof queryTerms>) {
  return compileRelevance(terms)(text,title);
}

// Build matchers once per request, not once per term, candidate and source line.
export function compileRelevance(terms:ReturnType<typeof queryTerms>) {
  const matcher=(raw:string)=>{
    const word=normalizeRecallText(raw);
    if(!word)return (_:string)=>false;
    if(/[\p{Script=Han}]/u.test(word))return (s:string)=>s.includes(word);
    const escaped=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`,'u');
    return (s:string)=>re.test(s);
  };
  const exact=terms.exact.map(raw=>({word:normalizeRecallText(raw),has:matcher(raw)}));
  const groups=terms.groups.map(g=>({generic:genericConcepts.has(g[0]),has:g.map(matcher)}));
  const stages=(s:string)=>[...s.matchAll(/\bphase (\d+)\b/g)].map(m=>m[1]);
  const requested=stages(terms.exact[0]||'');
  const normalized=(body:string,head:string)=>{
  const present=requested.length?stages(head+' '+body):[];
  if(requested.length&&present.length&&!requested.some(n=>present.includes(n)))return 0;
  let score=0,specificExact=false,matchedGroups=0,specificGroup=false;
  for(const {word,has} of exact){if(!word)continue;if(has(body)||has(head)){
    score+=8+(has(head)?8:0)+Math.min(8,word.length);
    if(!genericWords.has(word))specificExact=true;
  }}
  // Topic/path matches are stronger than body-only expansions. Every matched concept counts once.
  for(const group of groups){const inHead=group.has.some(has=>has(head));
    if(inHead||group.has.some(has=>has(body))){
      score+=inHead?18:10;matchedGroups++;if(!group.generic)specificGroup=true;
    }
  }
  const grams=terms.grams.filter(w=>body.includes(w)||head.includes(w)).length;
  // "test" alone must not turn a specific question about an expired state into unrelated facts.
  const enoughGrams=grams>0&&grams>=Math.min(2,terms.grams.length);
  if(!specificExact&&!specificGroup&&matchedGroups<2&&!enoughGrams&&
    !genericWords.has(terms.exact[0]||''))return 0;
  // A short titled note should not lose to a diary containing more incidental query grams.
  const headGrams=terms.grams.filter(w=>head.includes(w)).length;
  return score+(grams>=Math.min(2,terms.grams.length)?grams:0)+headGrams*12;
  };
  return Object.assign((text:string,title:string)=>normalized(normalizeRecallText(text),normalizeRecallText(title)),{normalized});
}
