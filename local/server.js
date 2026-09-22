import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './database.js';
import {handle} from '../server/worker.js';
import {maintenance} from '../server/matches.js';

const root=fileURLToPath(new URL('../',import.meta.url)),publicRoot=resolve(root,'public');
mkdirSync(resolve(root,'.data'),{recursive:true});
const port=Number(process.env.PORT??8787),host=process.env.HOST??'127.0.0.1';
const env={...process.env,DEV_LOCAL:'1',PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN??`http://localhost:${port}`,RATE_LIMIT_SALT:process.env.RATE_LIMIT_SALT??'local-development-only',DB:openDatabase(process.env.DATABASE_PATH??resolve(root,'.data/game.sqlite'))};
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
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
    const request=new Request(new URL(req.url,env.PUBLIC_ORIGIN),{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:req,duplex:'half'}:{})});
    const response=await handle(request,env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Internal error');}
});
server.listen(port,host,()=>console.log(`JEV Arcade: ${env.PUBLIC_ORIGIN}\n${env.TYPESAFE_API_KEY?'Hosted JEV enabled':'No API key: clearly labeled local perfect-play fallback'}\nSQLite: ${process.env.DATABASE_PATH??'.data/game.sqlite'}`));
const timer=setInterval(()=>maintenance(env).catch(()=>console.error('Maintenance failed')),60000);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close(()=>{env.DB.close();process.exit(0);});});
