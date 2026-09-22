import {assert,sha256,json} from './util.js';
import {one,all} from './store.js';
import {contextFor} from './auth.js';
import {configuration,publicMatch} from './matches.js';
import {summarizeMatches,csv} from '../public/game/analytics.js';

export async function history(env,session,url) {
  const limit=Math.max(1,Math.min(100,Number(url.searchParams.get('limit')??50)||50));
  const beforeTime=Number(url.searchParams.get('beforeTime')??Number.MAX_SAFE_INTEGER),beforeId=url.searchParams.get('beforeId')??'~';
  assert(Number.isSafeInteger(beforeTime)&&typeof beforeId==='string'&&beforeId.length<=80,400,'invalid_cursor');
  const rows=await all(env,`SELECT doc FROM matches WHERE (owner_session=? OR (? IS NOT NULL AND user_id=?)) AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`,session.token_hash,session.user_id??null,session.user_id??null,beforeTime,beforeTime,beforeId,limit+1);
  const more=rows.length>limit,docs=rows.slice(0,limit).map(r=>JSON.parse(r.doc)),last=docs.at(-1);
  return {matches:docs.map(publicMatch),next:more?{beforeTime:last.startedAt,beforeId:last.id}:null,scope:'own_account_or_current_guest_session',limit};
}
export async function analytics(env,session,url) {
  const rows=await all(env,`SELECT doc FROM matches WHERE (owner_session=? OR (? IS NOT NULL AND user_id=?)) AND status IN ('complete','void') ORDER BY created_at DESC,id DESC LIMIT 501`,session.token_hash,session.user_id??null,session.user_id??null);
  let docs=rows.slice(0,500).map(r=>JSON.parse(r.doc));
  const difficulty=url.searchParams.get('difficulty'),mark=url.searchParams.get('mark'),configHash=url.searchParams.get('config');
  if(difficulty)docs=docs.filter(m=>m.config.difficulty===difficulty);
  if(mark)docs=docs.filter(m=>m.humanMark===mark);
  if(configHash)docs=docs.filter(m=>m.configHash===configHash);
  return {summary:summarizeMatches(docs),coverage:{matchesIncluded:docs.length,newestLimit:500,truncated:rows.length>500,filterAppliedAfterLimit:true},asOf:new Date().toISOString()};
}
export async function leaderboard(env,session,url) {
  const scope=url.searchParams.get('scope')??'world',difficulty=url.searchParams.get('difficulty')??'normal',mark=url.searchParams.get('mark')??'X';
  assert(['world','server','channel'].includes(scope)&&['X','O'].includes(mark),400,'invalid_leaderboard_filter');
  const configHash=url.searchParams.get('config')??await sha256(configuration(env,difficulty));
  assert(/^[a-f0-9]{64}$/.test(configHash),400,'invalid_config');
  let scopeSql='',args=[];
  if(scope!=='world'){
    const context=contextFor(session??{});assert(session?.user_id && context,403,'fresh_discord_context_required');
    scopeSql=scope==='server'?' AND guild_id=?':' AND channel_id=?';args.push(scope==='server'?context.guildId:context.channelId);
  }
  const limit=Math.max(1,Math.min(100,Number(url.searchParams.get('limit')??50)||50));
  const asOf=Number(url.searchParams.get('asOf')??Date.now()),offset=Number(url.searchParams.get('offset')??0);
  assert(Number.isSafeInteger(asOf)&&asOf>0&&asOf<=Date.now()&&Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,400,'invalid_cursor');
  const rows=await all(env,`WITH totals AS (
    SELECT user_id,COUNT(*) games,SUM(outcome='win') wins,SUM(outcome='draw') draws,SUM(outcome='loss') losses,SUM(termination IN ('resign','expired')) forfeits
    FROM matches WHERE eligible=1 AND status='complete' AND user_id IS NOT NULL AND config_hash=? AND human_mark=? AND finished_at<=?${scopeSql} GROUP BY user_id
  ), scored AS (SELECT *, (wins+0.5*draws)*1.0/games result_rate,CASE WHEN games>=20 THEN 1 ELSE 0 END qualified FROM totals),
  ranked AS (SELECT *,DENSE_RANK() OVER(PARTITION BY qualified ORDER BY result_rate DESC) position FROM scored)
  SELECT ranked.*,users.display_name FROM ranked JOIN users ON users.id=ranked.user_id WHERE users.moderation_state='active' ORDER BY qualified DESC,result_rate DESC,user_id ASC LIMIT ? OFFSET ?`,configHash,mark,asOf,...args,limit+1,offset);
  return {scope,configHash,humanMark:mark,asOf,minimumGames:20,entries:rows.slice(0,limit).map(r=>({playerId:r.user_id,displayName:r.display_name,rank:r.qualified?r.position:null,provisional:!r.qualified,games:r.games,wins:r.wins,draws:r.draws,losses:r.losses,forfeits:r.forfeits,resultRate:r.result_rate})),next:rows.length>limit?{offset:offset+limit,asOf}:null};
}
export function moveCsv(matches) {
  return csv(matches.flatMap(m=>m.actions.map(a=>({matchId:m.id,configHash:m.configHash,difficulty:m.config.difficulty,humanMark:m.humanMark,eligible:m.eligible,ply:a.analysis.ply,actor:a.actor,mark:a.mark,cell:a.cell,source:a.decision?.source??'human',board:a.analysis.board,canonicalBoard:a.analysis.canonicalBoard,valueBefore:a.analysis.valueBefore,valueAfter:a.analysis.valueAfter,optimal:a.analysis.optimal,regret:a.analysis.regret,errorType:a.analysis.errorType,missedWin:a.analysis.missedImmediateWin,missedBlock:a.analysis.missedNecessaryBlock,latencyMs:a.decision?.latencyMs??null,humanDwellMs:a.serverDwellMs,inputTokens:a.decision?.response?.usage?.input_tokens??null,outputTokens:a.decision?.response?.usage?.output_tokens??null,confidence:a.decision?.response?.answers?.preference?.confidence??null,entropyBits:a.decision?.distribution?.entropyBits??null,fallbackReason:a.decision?.fallbackReason??null,estimatedCostUsd:a.decision?.estimatedCostUsd??null}))));
}
