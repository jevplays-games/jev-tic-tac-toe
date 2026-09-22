import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
/** D1-compatible interface over Node's built-in SQLite; no SQL mocking in tests. */
export function openDatabase(path=':memory:') {
  const sqlite=new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  sqlite.exec(readFileSync(new URL('../migrations/0001.sql',import.meta.url),'utf8'));
  function wrap(sql,params=[]) {
    const execute=kind=>{
      const statement=sqlite.prepare(sql);
      if(kind==='first')return statement.get(...params)??null;
      if(kind==='all')return {success:true,results:statement.all(...params)};
      const result=statement.run(...params);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};
    };
    return {bind(...values){return wrap(sql,values);},async first(column){const row=execute('first');return column?row?.[column]??null:row;},async all(){return execute('all');},async run(){return execute('run');},_execute:()=>execute('run')};
  }
  return {prepare:wrap,async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s._execute());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}},async exec(sql){sqlite.exec(sql);},close(){sqlite.close();}};
}
