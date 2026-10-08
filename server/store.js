import {assert,HttpError,sha256} from './util.js';
export const one=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
export const all=async(env,sql,...args)=>(await env.DB.prepare(sql).bind(...args).all()).results;
export const run=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).run();
export async function quota(env,subject,limit,windowMs) {
  const at=Date.now(),bucket=Math.floor(at/windowMs);
  const id=await sha256(`${env.RATE_LIMIT_SALT??'local'}|${subject}|${windowMs}|${bucket}`);
  const row=await one(env,'INSERT INTO quotas(id,n,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET n=n+1 WHERE n<? RETURNING n',id,(bucket+1)*windowMs,limit);
  assert(row,429,'rate_limit');return row.n;
}
export async function getMatch(env,id) {const row=await one(env,'SELECT doc FROM matches WHERE id=?',id);return row?JSON.parse(row.doc):null;}
export function matchParams(doc) {return [doc.revision,doc.status,doc.eligible?1:0,doc.outcome??null,doc.termination??null,doc.finishedAt??null,JSON.stringify(doc)];}
export async function saveMatch(env,doc,expectedRevision) {
  const result=await run(env,'UPDATE matches SET revision=?,status=?,eligible=?,outcome=?,termination=?,finished_at=?,doc=? WHERE id=? AND revision=?',...matchParams(doc),doc.id,expectedRevision);
  assert(result.meta.changes===1,409,'stale_revision');
}
export const ACTIVE_MATCH_SQL=`status IN ('human_turn','jev_pending') AND (owner_session=? OR (? IS NOT NULL AND user_id=?))`;
export const activeMatchFor=(env,session)=>one(env,`SELECT id FROM matches WHERE ${ACTIVE_MATCH_SQL} LIMIT 1`,session.token_hash,session.user_id??null,session.user_id??null);
// One statement checks for an active match and inserts, so concurrent creates cannot both be admitted. Returns false when
// another active match or the same creation key already exists; the caller reads back which.
export async function insertMatch(env,doc,session,fingerprint) {
  try{
    const result=await run(env,`INSERT INTO matches(id,owner_session,user_id,create_key,create_fingerprint,config_hash,difficulty,model_id,human_mark,guild_id,channel_id,revision,status,ranked_started,eligible,created_at,expires_at,doc)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM matches WHERE ${ACTIVE_MATCH_SQL})`,
      doc.id,session.token_hash,session.user_id,doc.createKey,fingerprint,doc.configHash,doc.config.difficulty,doc.config.modelId,doc.humanMark,doc.context?.guildId??null,doc.context?.channelId??null,doc.revision,doc.status,doc.rankedStarted?1:0,doc.eligible?1:0,doc.startedAt,doc.expiresAt,JSON.stringify(doc),
      session.token_hash,session.user_id??null,session.user_id??null);
    return result.meta.changes===1;
  }catch(e){if(/UNIQUE|constraint/i.test(e.message))return false;throw e;}
}
