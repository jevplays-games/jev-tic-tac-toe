// Writes a completed fixture match (provider is the in-process fixture, not a real call) for `npm run verify-export -- <file>`.
// usage: node tests/make-export-fixture.js path/to/export.json
import {writeFileSync} from 'node:fs';
import {environment,browser,start,playToEnd} from './helpers.js';
const path=process.argv[2];if(!path){console.error('Usage: node tests/make-export-fixture.js path/to/export.json');process.exit(1);}
const env=environment(),client=await browser(env),match=await playToEnd(client,await start(client));
if(match.status!=='complete'){console.error('fixture match did not complete');process.exit(1);}
writeFileSync(path,JSON.stringify({matches:[match]},null,2)+'\n');env.DB.close();
