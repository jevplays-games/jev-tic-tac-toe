import {recordOperation,operationReport} from './operations.js';
import {assert,HttpError,json,readJson,sha256} from './util.js';
import {sessionFor,userFor,requireMutation,contextFor,beginLogin,completeLogin,logout,isLocal} from './auth.js';
import {interaction,redeemContext} from './discord.js';
import {all,quota} from './store.js';
import {createMatch,ownedMatch,publicMatch,act,driveJev,expireMatch,maintenance,configuration} from './matches.js';
import {analytics,history,leaderboard} from './reporting.js';

export const SECURITY_HEADERS={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
export async function handle(request,env) {
  const requestId=crypto.randomUUID(),url=new URL(request.url),started=performance.now();let response,errorCode='ok';
  try{
    assert(env.PUBLIC_ORIGIN,503,'origin_not_configured');
    assert(isLocal(env)||env.RATE_LIMIT_SALT,503,'rate_limit_salt_required');
    if(!url.pathname.startsWith('/api/'))response=await env.ASSETS.fetch(request);
    else response=await api(request,env,url);
  }catch(e){
    const status=e instanceof HttpError?e.status:500;errorCode=e instanceof HttpError?e.code:'internal_error';
    if(status===500)console.error(JSON.stringify({type:'request_failed',requestId,code:'internal_error',path:url.pathname}));
    response=json({error:e instanceof HttpError?e.code:'internal_error',...(e.detail?{detail:e.detail}:{}),requestId},status,status===429?{'Retry-After':'60'}:{});
  }
  if(url.pathname.startsWith('/api/')&&env.DB){try{await recordOperation(env,{path:url.pathname,method:request.method,status:response.status,code:errorCode,durationMs:performance.now()-started});}catch{console.error(JSON.stringify({type:'metrics_write_failed',requestId}));}}
  const headers=new Headers(response.headers);for(const [k,v] of Object.entries(SECURITY_HEADERS))headers.set(k,v);
  headers.set('X-Request-Id',requestId);
  if(!isLocal(env))headers.set('Strict-Transport-Security','max-age=31536000');
  return new Response(response.body,{status:response.status,headers});
}
async function api(request,env,url) {
  const path=url.pathname,method=request.method;
  const ip=request.headers.get('cf-connecting-ip')??(isLocal(env)?'local':'unknown');
  await quota(env,`ip-api:${ip}`,Number(env.API_REQUESTS_PER_MINUTE??600),60000);
  if(path==='/api/admin/operations'&&method==='GET')return json(await operationReport(request,env));
  if(path==='/api/discord/interactions'&&method==='POST')return interaction(request,env);
  if(path==='/api/auth/discord'&&method==='GET')return beginLogin(request,env);
  if(path==='/api/auth/discord/callback'&&method==='GET')return completeLogin(request,env);
  if(path==='/api/leaderboard'&&method==='GET'&&(url.searchParams.get('scope')??'world')==='world')return json(await leaderboard(env,null,url));
  const {session,headers}=await sessionFor(request,env,path==='/api/me'&&method==='GET');
  await quota(env,`api:${session.token_hash}`,240,60000);
  if(method==='POST')requireMutation(request,env,session);
  if(path==='/api/me'&&method==='GET'){
    const user=await userFor(env,session);
    const active=await all(env,`SELECT id FROM matches WHERE status IN ('human_turn','jev_pending') AND (owner_session=? OR (? IS NOT NULL AND user_id=?)) ORDER BY created_at DESC LIMIT 1`,session.token_hash,session.user_id??null,session.user_id??null);
    const configs={};for(const d of ['easy','normal','hard','jev'])configs[d]={...configuration(env,d),hash:await sha256(configuration(env,d))};
    return json({user:user?{id:user.id,displayName:user.display_name}:null,csrf:session.csrf,context:contextFor(session),pendingLaunch:Boolean(session.pending_launch),activeMatchId:active[0]?.id??null,jevConfigured:Boolean(env.TYPESAFE_API_KEY),discordConfigured:Boolean(env.DISCORD_APPLICATION_ID&&env.DISCORD_CLIENT_SECRET),configs},200,headers);
  }
  if(path==='/api/logout'&&method==='POST')return logout(request,env,session);
  if(path==='/api/context/redeem'&&method==='POST')return json({context:await redeemContext(env,session)});
  if(path==='/api/matches'&&method==='POST'){const doc=await createMatch(env,session,await readJson(request));return json(publicMatch(doc),doc.status==='jev_pending'?202:201);}
  if(path==='/api/history'&&method==='GET')return json(await history(env,session,url));
  if(path==='/api/analytics'&&method==='GET')return json(await analytics(env,session,url));
  if(path==='/api/leaderboard'&&method==='GET')return json(await leaderboard(env,session,url));
  const match=path.match(/^\/api\/matches\/([a-f0-9-]{36})(?:\/(actions|resume))?$/);
  if(match){
    if(!match[2]&&method==='GET')return json(publicMatch(await ownedMatch(env,session,match[1])));
    if(match[2]==='actions'&&method==='POST'){const doc=await act(env,session,match[1],await readJson(request));return json(publicMatch(doc),doc.status==='jev_pending'?202:200);}
    if(match[2]==='resume'&&method==='POST'){
      let doc=await ownedMatch(env,session,match[1]);
      doc=Date.now()>=doc.expiresAt?await expireMatch(env,doc):await driveJev(env,doc);
      return json(publicMatch(doc),doc.status==='jev_pending'?202:200);
    }
  }
  throw new HttpError(404,'not_found');
}
export default {fetch:handle,async scheduled(_controller,env,ctx){ctx.waitUntil(maintenance(env));}};
