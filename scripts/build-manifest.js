import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const files=[];for(const dir of ['public','server','local','migrations']){function walk(path){for(const entry of readdirSync(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())walk(file);else if(!['server/build-info.js','public/reference-audit.json'].includes(file))files.push(file);}}walk(dir);}
files.sort();const hash=createHash('sha256');const items=files.map(path=>{const bytes=readFileSync(path);hash.update(path+'\0');hash.update(bytes);return {path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};});
const sourceHash=hash.digest('hex');writeFileSync('server/build-info.js',`// Generated from public/server/local/migrations sources, excluding this file and reference-audit.json.\nexport const SOURCE_REVISION = '${sourceHash}';\n`);
writeFileSync('reports/build-manifest.json',JSON.stringify({schemaVersion:1,sourceHash,files:items},null,2)+'\n');console.log(sourceHash);
