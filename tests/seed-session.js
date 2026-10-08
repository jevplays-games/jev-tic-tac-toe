// Scratch-database helper for browser checks: creates a fixture account and signed-in session, prints the cookie token.
// usage: DATABASE_PATH=/scratch/ttt.sqlite node tests/seed-session.js "Display Name"
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {openDatabase} from '../local/database.js';
const path=process.env.DATABASE_PATH;
if(!path||path===':memory:'){console.error('DATABASE_PATH must name a scratch SQLite file');process.exit(1);}
const name=process.argv[2]??'Fixture Player',db=openDatabase(path),now=Date.now();
const token=randomBytes(32).toString('hex'),userId=randomUUID(),discordId=String(100000000000000000n+BigInt('0x'+randomBytes(5).toString('hex')));
await db.prepare('INSERT INTO users(id,discord_id,display_name,created_at,last_seen_at) VALUES(?,?,?,?,?)').bind(userId,discordId,name,now,now).run();
await db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)').bind(createHash('sha256').update(token).digest('hex'),userId,randomBytes(32).toString('hex'),now,now,now+604800000).run();
console.log(JSON.stringify({token,userId,name}));
db.close();
