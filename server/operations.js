import {all,run} from './store.js';
import {assert,safeEqual,sha256} from './util.js';
export function normalizedRoute(path){
  if(/^\/api\/matches\/[a-f0-9-]{36}(\/actions|\/resume)?$/.test(path))return path.replace(/[a-f0-9-]{36}/,':id');
  if(['/api/me','/api/matches','/api/history','/api/analytics','/api/leaderboard','/api/logout','/api/context/redeem','/api/discord/interactions','/api/auth/discord','/api/auth/discord/callback','/api/admin/operations'].includes(path))return path;
  return '/api/unknown';
}
export async function recordOperation(env,{path,method,status,code,durationMs}){
  const day=new Date().toISOString().slice(0,10),bucket=durationMs<10?'0-10':durationMs<50?'10-50':durationMs<100?'50-100':durationMs<500?'100-500':durationMs<1000?'500-1000':durationMs<3000?'1000-3000':'3000+';
  await run(env,`INSERT INTO operational_counters(day,route,method,status,code,latency_bucket,n,sum_ms,max_ms) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(day,route,method,status,code,latency_bucket) DO UPDATE SET n=n+1,sum_ms=sum_ms+excluded.sum_ms,max_ms=MAX(max_ms,excluded.max_ms)`,day,normalizedRoute(path),['GET','POST','HEAD','OPTIONS','PUT','PATCH','DELETE'].includes(method)?method:'OTHER',status,code,bucket,durationMs,durationMs);
}
export async function operationReport(request,env){
  assert(env.ADMIN_ANALYTICS_KEY,404,'not_found');
  const token=request.headers.get('authorization')?.replace(/^Bearer /,'');
  assert(token && safeEqual(await sha256(token),await sha256(env.ADMIN_ANALYTICS_KEY)),403,'admin_rejected');
  const day=new URL(request.url).searchParams.get('day')??new Date().toISOString().slice(0,10);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(day),400,'invalid_day');
  const rows=await all(env,'SELECT * FROM operational_counters WHERE day=? ORDER BY route,method,status,latency_bucket',day);
  const count=rows.reduce((sum,r)=>sum+r.n,0);
  return {schemaVersion:1,day,basis:'anonymous aggregate HTTP counters; request duration excludes this counter write',requests:count,meanLatencyMs:count?rows.reduce((sum,r)=>sum+r.sum_ms,0)/count:null,maxLatencyMs:rows.length?Math.max(...rows.map(r=>r.max_ms)):null,rows};
}
