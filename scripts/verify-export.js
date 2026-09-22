import {readFileSync} from 'node:fs';
import {verifyMatch} from '../server/matches.js';
const path=process.argv[2];if(!path){console.error('Usage: npm run verify-export -- path/to/export.json');process.exit(1);}
try{
  const input=JSON.parse(readFileSync(path,'utf8')),matches=input.matches??[input],results=[];
  for(const match of matches){if(!['complete','void'].includes(match.status)){results.push({id:match.id,ok:null,reason:'active_match_not_exported_with_full_evidence'});continue;}if(match.local){results.push({id:match.id,ok:false,reason:'browser_local_untrusted'});continue;}results.push({id:match.id,...await verifyMatch(match)});}
  console.log(JSON.stringify({matches:results.length,results},null,2));if(results.some(r=>r.ok===false))process.exitCode=1;
}catch(e){console.error(e.message);process.exitCode=1;}
