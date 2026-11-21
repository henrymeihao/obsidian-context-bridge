import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('activity migration is additive, repeatable and matches fresh install schema', () => {
  const db=new DatabaseSync(':memory:');
  const fresh=new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE notes(path TEXT PRIMARY KEY,content TEXT NOT NULL,lower_content TEXT NOT NULL,bytes INTEGER NOT NULL,modified TEXT,etag TEXT,indexed_at TEXT NOT NULL,seen_generation TEXT NOT NULL DEFAULT ''); CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO notes(path,content,lower_content,bytes,indexed_at) VALUES('demo.md','Preserved','preserved',9,'fixture'); INSERT INTO index_meta VALUES('root','fixture');");
    const migration=readFileSync(new URL('../migrations/0001_shared_activity.sql',import.meta.url),'utf8');
    db.exec(migration);db.exec(migration);
    assert.equal(db.prepare('SELECT content FROM notes').get()!.content,'Preserved');
    assert.equal(db.prepare('SELECT value FROM index_meta').get()!.value,'fixture');
    fresh.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
    assert.deepEqual(db.prepare('PRAGMA table_info(shared_activity)').all(),fresh.prepare('PRAGMA table_info(shared_activity)').all());
    assert.deepEqual(db.prepare('PRAGMA index_list(shared_activity)').all(),fresh.prepare('PRAGMA index_list(shared_activity)').all());
  } finally {db.close();fresh.close();}
});

test('V3 migration preserves Activity and note data and matches fresh schema',()=>{
 const db=new DatabaseSync(':memory:'),fresh=new DatabaseSync(':memory:');
 try{
  const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
  db.exec(schema.split('-- Additive only;')[0]);
  db.exec("INSERT INTO shared_activity(vault,event_id,payload,fingerprint,project,task_id,occurred_at,recorded_at) VALUES('fixture','preserved','{}','hash','demo','task','2026','2026')");
  const migration=readFileSync(new URL('../migrations/0002_personal_memory.sql',import.meta.url),'utf8');
  db.exec(migration);db.exec(migration);fresh.exec(schema);
  assert.equal(db.prepare('SELECT event_id FROM shared_activity').get()!.event_id,'preserved');
  for(const table of ['personal_memory','memory_views']){
    assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all(),fresh.prepare(`PRAGMA table_info(${table})`).all());
    assert.deepEqual(db.prepare(`PRAGMA index_list(${table})`).all(),fresh.prepare(`PRAGMA index_list(${table})`).all());
  }
 }finally{db.close();fresh.close();}
});
