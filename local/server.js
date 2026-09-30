import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isProduction} from './mode.js';
import {openDatabase} from './database.js';
import {handle} from '../server/worker.js';
import {maintenance} from '../server/matches.js';

const root=fileURLToPath(new URL('../',import.meta.url)),publicRoot=resolve(root,'public');
const production=isProduction();
const port=Number(process.env.PORT??8787),host=process.env.HOST??(production?'0.0.0.0':'127.0.0.1');
const dbPath=process.env.DATABASE_PATH??resolve(root,production?'data/game.sqlite':'.data/game.sqlite');
mkdirSync(dirname(dbPath),{recursive:true});
// Production mode (NODE_ENV=production or an https non-loopback PUBLIC_ORIGIN, e.g. GoDaddy Node hosting): behaves like the Worker deployment. DEV_LOCAL is not set, so ranked play, Discord and Secure cookies are on, and the origin and salt are mandatory.
if(production){for(const k of ['PUBLIC_ORIGIN','RATE_LIMIT_SALT'])if(!process.env[k]){console.error(`${k} is required in production mode`);process.exit(1);}}
const env={...process.env,...(production?{}:{DEV_LOCAL:'1'}),PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN??`http://localhost:${port}`,RATE_LIMIT_SALT:process.env.RATE_LIMIT_SALT??'local-development-only',DB:openDatabase(dbPath)};
// Behind a trusted TLS-terminating proxy (TRUST_PROXY=1) the client IP for rate limiting is the last X-Forwarded-For hop, which the proxy itself appended.
const trustProxy=process.env.TRUST_PROXY==='1';
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2'};
env.ASSETS={async fetch(request){
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  let pathname;try{pathname=decodeURIComponent(new URL(request.url).pathname);}catch{return new Response('Bad path',{status:400});}
  const file=resolve(publicRoot,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(publicRoot+sep))return new Response('Not found',{status:404});
  try{if(!(await stat(file)).isFile())return new Response('Not found',{status:404});return new Response(request.method==='HEAD'?null:await readFile(file),{headers:{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':'no-cache'}});}catch{return new Response('Not found',{status:404});}
}};
const server=http.createServer(async(req,res)=>{
  try{
    // Never trust forwarded headers in the loopback development server.
    const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v!==undefined&&!k.toLowerCase().startsWith('cf-')&&!k.toLowerCase().startsWith('x-forwarded-'))headers.set(k,Array.isArray(v)?v.join(','):v);
    if(trustProxy){const hop=String(req.headers['x-forwarded-for']??'').split(',').pop().trim();if(hop)headers.set('cf-connecting-ip',hop);}
    const request=new Request(new URL(req.url,env.PUBLIC_ORIGIN),{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:req,duplex:'half'}:{})});
    const response=await handle(request,env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Internal error');}
});
server.listen(port,host,()=>console.log(`JEV Arcade: ${env.PUBLIC_ORIGIN} (${production?'production':'local dev'}, ${host}:${port})\n${env.TYPESAFE_API_KEY?'Hosted JEV enabled':'No API key: clearly labeled local perfect-play fallback'}\nSQLite: ${dbPath}`));
const timer=setInterval(()=>maintenance(env).catch(()=>console.error('Maintenance failed')),60000);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close(()=>{env.DB.close();process.exit(0);});});
