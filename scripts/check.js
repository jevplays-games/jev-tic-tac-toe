import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const files=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules')continue;const path=join(dir,e.name);if(e.isDirectory())walk(path);else if(e.name.endsWith('.js'))files.push(path);}}
walk('.');for(const file of files)execFileSync(process.execPath,['--check',file],{stdio:'pipe'});console.log(`${files.length} JavaScript files parsed successfully.`);
