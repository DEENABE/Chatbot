import {AND_NAMED_ITEM} from './AppLaunchTask.js';
// No application names here. Adapters are not required for admission.
export function genericDesktopTask(message){
  const text=String(message||'').trim();
  if(/^(?:explain|describe|how|what|write (?:a|an) (?:story|essay))\b/i.test(text))return null;
  if(AND_NAMED_ITEM.test(text.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(?:my\s+|the\s+)?/i,'').replace(/[.!?]+$/,'')))return null;
  let m=text.match(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(?:my\s+|the\s+)?(.+?)\s+(?:(?:and(?: then)?|then)\s+)(.+)$/i);
  if(!m)m=text.match(/^(?:open|launch|start|run)\s+(?:my\s+|the\s+)?(.+?)\s+((?:go to|navigate to|show)\s+.+)$/i);
  if(!m){const reverse=text.match(/^((?:create|add|open|find|search|select|click|type|enter|calculate|play|pause)\s+.+?)\s+(?:in|using)\s+(.+)$/i);if(reverse)m=[reverse[0],reverse[2],reverse[1]];}
  if(!m)return null;
  const query=m[1].trim().replace(/\s+app$/i,''),goal=m[2].trim();
  if(!query||query.includes('&&')||query.length>200||/[\\/:;|<>`$\x00-\x1f]/.test(query))return null;
  return {query,goal,task:text};
}
export const desktopSnapshot=data=>data?.snapshot?.status==='UI_OBSERVED'?data.snapshot:data?.status==='UI_OBSERVED'?data:null;
export function desktopCompletion(data,task){return data?.success===true && data.status==='UI_GOAL_EVIDENCE_VERIFIED' && data.goal===task &&
  typeof data.snapshotId==='string' && Array.isArray(data.evidence) && data.evidence.length>0 &&
  data.verification?.criterion==='fresh_goal_evidence' && data.verification.status==='verified' && Number.isFinite(Date.parse(data.verification.observedAt));}
