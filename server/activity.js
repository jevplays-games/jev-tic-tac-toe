// Discord Activity support. Discord loads the game in an iframe on <application id>.discordsays.com, where a
// SameSite cookie is not sent, so the game signs the player in through the Embedded App SDK and then keeps a
// bearer session token in memory. Nothing here changes the normal browser sign-in.
import {assert,randomToken,sha256,json,readJson} from './util.js';
import {run,quota} from './store.js';
import {activityOrigin,isLocal,discordIdentity,upsertDiscordUser} from './auth.js';

export function activityConfig(env) {
  assert(env.DISCORD_APPLICATION_ID&&env.DISCORD_CLIENT_SECRET,503,'discord_not_configured');
  return json({clientId:env.DISCORD_APPLICATION_ID});
}
export async function createActivitySession(request,env) {
  assert(env.DISCORD_APPLICATION_ID&&env.DISCORD_CLIENT_SECRET,503,'discord_not_configured');
  const origin=request.headers.get('origin');
  assert(origin&&(origin===activityOrigin(env)||origin===new URL(env.PUBLIC_ORIGIN).origin),403,'origin_rejected');
  const ip=request.headers.get('cf-connecting-ip')??(isLocal(env)?'local':'unknown');
  await quota(env,`activity-session:${ip}`,Number(env.SESSION_CREATIONS_PER_HOUR??60),3600000);
  const {code}=await readJson(request);
  assert(typeof code==='string'&&code.length>0&&code.length<2048,400,'invalid_code');
  // An SDK authorization code is exchanged without a redirect URI.
  const {identity,accessToken}=await discordIdentity(env,code,null);
  const user=await upsertDiscordUser(env,identity),at=Date.now(),raw=randomToken(),csrf=randomToken();
  await run(env,'INSERT INTO sessions(token_hash,user_id,csrf,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)',await sha256(raw),user.id,csrf,at,at,at+86400000);
  // The Discord access token is returned once so the SDK can authenticate; it is never stored or logged.
  return json({token:raw,csrf,accessToken,user:{id:user.id,displayName:user.display_name}});
}
