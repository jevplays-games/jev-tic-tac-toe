import {assert,HttpError,randomToken,sha256,safeEqual,json,boundedJson} from './util.js';
import {one,run,quota} from './store.js';
export function isLocal(env) {return env.DEV_LOCAL==='1' && ['localhost','127.0.0.1','[::1]'].includes(new URL(env.PUBLIC_ORIGIN).hostname);}
export function cookieName(env){return isLocal(env)?'jev_dev_session':'__Host-jev_session';}
export function cookie(env,token,age=604800){return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${isLocal(env)?'':'; Secure'}`;}
export async function sessionFor(request,env,create=false) {
  const token=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(`${cookieName(env)}=`))?.split('=')[1];
  let session=token && /^[a-f0-9]{64}$/.test(token)?await one(env,'SELECT * FROM sessions WHERE token_hash=?',await sha256(token)):null;
  const at=Date.now();
  if(session && (session.expires_at<=at || session.last_seen_at<at-86400000))session=null;
  if(session){
    if(session.last_seen_at<at-60000)await run(env,'UPDATE sessions SET last_seen_at=? WHERE token_hash=?',at,session.token_hash);
    return {session,headers:{}};
  }
  if(!create)throw new HttpError(401,'session_required');
  const ip=request.headers.get('cf-connecting-ip')??(isLocal(env)?'local':'unknown');
  await quota(env,`session-new:${ip}`,Number(env.SESSION_CREATIONS_PER_HOUR??60),3600000);
  const raw=randomToken();session={token_hash:await sha256(raw),csrf:randomToken(),user_id:null,created_at:at,last_seen_at:at,expires_at:at+604800000};
  await run(env,'INSERT INTO sessions(token_hash,csrf,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?)',session.token_hash,session.csrf,at,at,session.expires_at);
  return {session,headers:{'Set-Cookie':cookie(env,raw)}};
}
export async function userFor(env,session){return session.user_id?await one(env,'SELECT id,discord_id,display_name,avatar_hash,moderation_state FROM users WHERE id=?',session.user_id):null;}
export function requireMutation(request,env,session) {
  assert(request.headers.get('origin')===new URL(env.PUBLIC_ORIGIN).origin,403,'origin_rejected');
  assert(safeEqual(request.headers.get('x-csrf-token'),session.csrf),403,'csrf_rejected');
}
export function contextFor(session) {
  try{const context=JSON.parse(session.context_json??'null');return context?.expiresAt>Date.now()?context:null;}catch{return null;}
}
export async function beginLogin(request,env) {
  assert(env.DISCORD_APPLICATION_ID && env.DISCORD_CLIENT_SECRET,503,'discord_not_configured');
  const {session,headers}=await sessionFor(request,env,true),url=new URL(request.url),state=randomToken();
  const launch=url.searchParams.get('launch');
  assert(!launch||/^[a-f0-9]{64}$/.test(launch),400,'invalid_launch');
  await run(env,'UPDATE sessions SET oauth_state_hash=?,oauth_expires=?,pending_launch=? WHERE token_hash=?',await sha256(state),Date.now()+300000,launch?await sha256(launch):null,session.token_hash);
  const params=new URLSearchParams({client_id:env.DISCORD_APPLICATION_ID,redirect_uri:`${env.PUBLIC_ORIGIN}/api/auth/discord/callback`,response_type:'code',scope:'identify',state});
  return new Response(null,{status:302,headers:{...headers,Location:`https://discord.com/oauth2/authorize?${params}`}});
}
export async function completeLogin(request,env) {
  const {session}=await sessionFor(request,env),params=new URL(request.url).searchParams,state=params.get('state'),code=params.get('code');
  assert(state && /^[a-f0-9]{64}$/.test(state) && session.oauth_expires>Date.now() && safeEqual(await sha256(state),session.oauth_state_hash),403,'oauth_state_rejected');
  const consumed=await run(env,'UPDATE sessions SET oauth_state_hash=NULL,oauth_expires=NULL WHERE token_hash=? AND oauth_state_hash=?',session.token_hash,session.oauth_state_hash);
  assert(consumed.meta.changes===1,403,'oauth_state_reused');assert(code && code.length<2048,400,'oauth_denied_or_missing_code');
  const fetchFn=env.FETCH??fetch;
  const tokenResponse=await fetchFn('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_APPLICATION_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:`${env.PUBLIC_ORIGIN}/api/auth/discord/callback`}),signal:AbortSignal.timeout(7000)});
  assert(tokenResponse.ok,502,'discord_token_failed');const tokens=await boundedJson(tokenResponse,32000);
  assert(typeof tokens.access_token==='string',502,'discord_token_invalid');
  const identityResponse=await fetchFn('https://discord.com/api/v10/users/@me',{headers:{Authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(7000)});
  assert(identityResponse.ok,502,'discord_identity_failed');const identity=await boundedJson(identityResponse,32000);
  assert(typeof identity.id==='string' && /^\d{5,25}$/.test(identity.id),502,'discord_identity_invalid');
  const at=Date.now(),newId=crypto.randomUUID();
  await run(env,'INSERT INTO users(id,discord_id,display_name,avatar_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET display_name=excluded.display_name,avatar_hash=excluded.avatar_hash,last_seen_at=excluded.last_seen_at',newId,identity.id,String(identity.global_name??identity.username??'Player').slice(0,100),typeof identity.avatar==='string'?identity.avatar:null,at,at);
  const user=await one(env,'SELECT * FROM users WHERE discord_id=?',identity.id);
  assert(user.moderation_state==='active',403,'account_restricted');
  const raw=randomToken(),newHash=await sha256(raw);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,pending_launch,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(newHash,user.id,randomToken(),session.pending_launch??null,at,at,at+604800000),
    env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.token_hash)
  ]);
  // OAuth tokens intentionally remain in memory only and are not logged or persisted.
  return new Response(null,{status:303,headers:{'Set-Cookie':cookie(env,raw),Location:'/'}});
}
export async function logout(request,env,session){requireMutation(request,env,session);await run(env,'DELETE FROM sessions WHERE token_hash=?',session.token_hash);return json({ok:true},200,{'Set-Cookie':cookie(env,'',0)});}
