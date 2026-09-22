import {assert,randomToken,sha256,json,readBody} from './util.js';
import {one,run} from './store.js';
import {userFor} from './auth.js';
function hexBytes(hex){return Uint8Array.from(hex.match(/.{2}/g)??[],b=>parseInt(b,16));}
export async function verifyInteraction(request,publicKey,body) {
  const signature=request.headers.get('x-signature-ed25519'),timestamp=request.headers.get('x-signature-timestamp');
  if(!/^[a-f0-9]{128}$/i.test(signature??'')||!/^\d{9,12}$/.test(timestamp??'')||!/^[a-f0-9]{64}$/i.test(publicKey??'')||Math.abs(Date.now()/1000-Number(timestamp))>300)return false;
  try{const key=await crypto.subtle.importKey('raw',hexBytes(publicKey),{name:'Ed25519'},false,['verify']);const prefix=new TextEncoder().encode(timestamp),message=new Uint8Array(prefix.length+body.length);message.set(prefix);message.set(body,prefix.length);return await crypto.subtle.verify('Ed25519',key,hexBytes(signature),message);}catch{return false;}
}
export async function interaction(request,env) {
  const body=await readBody(request,64000);
  assert(await verifyInteraction(request,env.DISCORD_PUBLIC_KEY,body),401,'discord_signature_rejected');
  let data;try{data=JSON.parse(new TextDecoder().decode(body));}catch{assert(false,400,'invalid_interaction');}
  if(data.type===1)return json({type:1});
  assert(data.application_id===env.DISCORD_APPLICATION_ID,403,'application_mismatch');
  const supported=data.type===2 && data.data?.name==='play' && data.data?.options?.some(o=>o.name==='tic-tac-toe'&&o.type===1);
  assert(supported,400,'unsupported_command');
  const identity=data.member?.user?.id;
  assert([data.guild_id,data.channel_id,identity,data.id].every(s=>typeof s==='string'&&/^\d{5,25}$/.test(s)),403,'guild_context_required');
  const existing=await one(env,'SELECT interaction_id FROM launches WHERE interaction_id=?',data.id);
  if(existing)return json({type:4,data:{content:'This launch was already issued. Run /play tic-tac-toe again for a new link.',flags:64}});
  const token=randomToken(),at=Date.now();
  try{await run(env,'INSERT INTO launches(token_hash,interaction_id,discord_id,guild_id,channel_id,issued_at,redeem_expires,context_expires) VALUES(?,?,?,?,?,?,?,?)',await sha256(token),data.id,identity,data.guild_id,data.channel_id,at,at+300000,at+900000);}catch(e){if(/UNIQUE/i.test(e.message))return json({type:4,data:{content:'Launch already issued. Run the command again.',flags:64}});throw e;}
  return json({type:4,data:{content:`Play Tic-Tac-Toe against JEV. This personal launch expires in five minutes.\n${env.PUBLIC_ORIGIN}/api/auth/discord?launch=${token}`,flags:64,allowed_mentions:{parse:[]}}});
}
export async function redeemContext(env,session) {
  const user=await userFor(env,session);assert(user && user.moderation_state==='active',401,'discord_login_required');
  assert(session.pending_launch,400,'no_pending_launch');
  const launch=await one(env,'SELECT * FROM launches WHERE token_hash=?',session.pending_launch),at=Date.now();
  assert(launch && launch.redeem_expires>at && launch.context_expires>at,403,'launch_expired');
  assert(launch.discord_id===user.discord_id,403,'launch_user_mismatch');
  assert(!launch.redeemed_session||launch.redeemed_session===session.token_hash,403,'launch_reused');
  const consumed=await run(env,'UPDATE launches SET redeemed_session=?,redeemed_at=? WHERE token_hash=? AND (redeemed_session IS NULL OR redeemed_session=?)',session.token_hash,at,launch.token_hash,session.token_hash);
  assert(consumed.meta.changes===1,403,'launch_reused');
  const context={guildId:launch.guild_id,channelId:launch.channel_id,issuedAt:launch.issued_at,expiresAt:launch.context_expires,launchHash:launch.token_hash};
  await run(env,'UPDATE sessions SET context_json=?,pending_launch=NULL WHERE token_hash=?',JSON.stringify(context),session.token_hash);
  return context;
}
