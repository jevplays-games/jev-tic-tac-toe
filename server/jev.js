import {getLegalActions} from '../public/game/rules.js';
import {buildJevRequest,validateJevResponse,selectJevAction} from '../public/game/policy.js';
import {minimaxAction} from '../public/game/oracle.js';
import {distributionStats} from '../public/game/analytics.js';
import {sha256,boundedJson} from './util.js';
export const JEV_ENDPOINT='https://api.typesafe.ai/v1/systemone';
export async function chooseJevAction({state,difficulty,modelId,apiKey,fetchFn=fetch,budgetMs=3000,beforeAttempt=async()=>{},inputPricePerMillion=null,outputPricePerMillion=null}) {
  const start=performance.now(),legal=getLegalActions(state);
  if(!legal.length)throw new Error('No legal JEV action');
  if(legal.length===1)return {action:legal[0],source:'forced',latencyMs:performance.now()-start,attempts:[],request:null,response:null,fallbackReason:null};
  const request=buildJevRequest(state,difficulty,modelId),inputHash=await sha256(request),attempts=[];
  let reason=apiKey?null:'missing_api_key';
  let response=null;
  if(apiKey)for(let index=0;index<2;index++){
    const remaining=budgetMs-(performance.now()-start);
    if(remaining<=0){reason='timeout';break;}
    try{await beforeAttempt({request,inputHash,attempt:index+1});}catch{reason='budget_or_rate_limit';break;}
    const attempt={index:index+1,startedAt:new Date().toISOString(),httpStatus:null,latencyMs:null,result:null};
    const tick=performance.now();let retry=false,retryDelay=150*(index+1);
    try{
      const raw=await fetchFn(JEV_ENDPOINT,{method:'POST',headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(Math.max(1,Math.floor(remaining)))});
      attempt.httpStatus=raw.status;
      if(!raw.ok){
        reason=`http_${raw.status}`;retry=raw.status===429||raw.status>=500;
        const retryHeader=raw.headers.get('retry-after');
        if(retryHeader){const seconds=Number(retryHeader);retryDelay=Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(retryHeader)-Date.now());if(!Number.isFinite(retryDelay))retryDelay=150;}
        await raw.body?.cancel();
      }else{
        const parsed=await boundedJson(raw);
        try{response=validateJevResponse(parsed,request);}catch(e){reason=e.message;}
        if(response){attempt.result='valid';attempt.latencyMs=performance.now()-tick;attempts.push(attempt);break;}
      }
    }catch(e){reason=e.name==='TimeoutError'||e.name==='AbortError'?'timeout':e instanceof SyntaxError?'malformed_json':e.status===413?'response_too_large':'transport_error';retry=reason==='transport_error';}
    attempt.result=reason;attempt.latencyMs=performance.now()-tick;attempts.push(attempt);
    if(!retry||index===1||performance.now()-start+retryDelay>=budgetMs)break;
    await new Promise(resolve=>setTimeout(resolve,Math.max(100,retryDelay)));
  }
  let action,source;
  if(response){action=selectJevAction(response,request,difficulty);source='jev';reason=null;}
  else{action=minimaxAction(state);source='fallback-minimax';}
  if(!legal.some(a=>a.cell===action.cell))throw new Error('Adapter selected illegal action');
  const usage=response?.usage;
  const priceKnown=typeof inputPricePerMillion==='number' && Number.isFinite(inputPricePerMillion) && inputPricePerMillion>=0 && typeof outputPricePerMillion==='number' && Number.isFinite(outputPricePerMillion) && outputPricePerMillion>=0;
  return {action,source,modelId:response?.model??null,inputHash,request,response,attempts,
    latencyMs:performance.now()-start,inputBytes:new TextEncoder().encode(JSON.stringify(request)).length,
    probabilities:response?.answers.preference.probabilities??null,
    distribution:distributionStats(response?.answers.preference.probabilities),
    fallbackReason:reason,
    estimatedCostUsd:usage&&priceKnown?(usage.input_tokens*inputPricePerMillion+usage.output_tokens*outputPricePerMillion)/1e6:null,
    costBasis:priceKnown?'operator_configured_token_prices':'not_configured'
  };
}
