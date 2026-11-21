import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {queryTerms,relevance} from '../src/recall.js';

test('FTS5 tokenizer probe: unicode61 Chinese subwords and two-character trigram limits',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("CREATE VIRTUAL TABLE words USING fts5(content,tokenize='unicode61'); CREATE VIRTUAL TABLE tri USING fts5(content,tokenize='trigram'); INSERT INTO words VALUES('正在考虑职业转型与AI产品'); INSERT INTO tri VALUES('正在考虑职业转型与AI产品');");
  const count=(table:string,word:string)=>db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(word)!.n;
  assert.equal(count('words','职业转型'),0);
  assert.equal(count('tri','职业转型'),1);
  assert.equal(count('tri','转型'),0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tri WHERE instr(content,'转型')>0").get()!.n,1);
 }finally{db.close();}
});

test('explicit bilingual expansions and CJK bigrams rank subject over unrelated recency',()=>{
 const text='正在考虑职业转型，先验证产品设计技能';
 for(const query of ['换职业','career change','职业转型 career transition','正在考虑职业转型的事']){
  assert.ok(relevance(text,'career-transition',queryTerms(query))>relevance('今天去了公园散步','recent-life',queryTerms(query)));
 }
 assert.equal(relevance('没有相关经历','other',queryTerms('不存在的火星记忆')),0);
 assert.ok(!queryTerms('chair repair').exact.includes('人工智能'),'ai substring is not AI entity');
});
