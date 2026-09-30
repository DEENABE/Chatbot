import {normalizeAppName,validAppQuery,settingsTopic} from './AppQueryNormalizer.js';
import {AppSearchIndex,aliasesFor,settingsTopicNames,isSettingsPage} from './AppSearchIndex.js';
import {scoreSearchName,editDistance} from './AppFuzzyMatcher.js';
export {normalizeAppName,normalizeAppName as normalize,aliasesFor,editDistance};
export const DEFAULT_RESOLVER_THRESHOLDS=Object.freeze({highConfidence:.90,highMargin:.06,mediumConfidence:.87,mediumMargin:.20,candidateFloor:.65});
export class AppResolverService{
 constructor({thresholds={}}={}){
  this.thresholds={...DEFAULT_RESOLVER_THRESHOLDS,...thresholds};
  for(const [key,value] of Object.entries(this.thresholds))if(!(key in DEFAULT_RESOLVER_THRESHOLDS)||!Number.isFinite(value)||value<0||value>1)throw new Error('INVALID_RESOLVER_THRESHOLD');
  if(this.thresholds.highConfidence<this.thresholds.mediumConfidence||this.thresholds.highMargin>this.thresholds.mediumMargin)throw new Error('INVALID_RESOLVER_THRESHOLD');
 }
 rank(query,apps,userAliases={}){
  if(!validAppQuery(query))return [];
  const q=normalizeAppName(query);if(!q)return [];
  const topic=settingsTopic(q);
  return new AppSearchIndex(apps).entries.map(({app,names})=>{
   let best={score:0,auto:false,matchedAgainst:'',matchType:'FUZZY'};
   // "X settings" / "settings for X": compare only X with a Settings page's topic names. Comparing the whole string
   // would let the shared word "settings" inflate similarity between unrelated pages ("open settings" vs "vpn settings").
   const byTopic=topic&&isSettingsPage(app),needle=byTopic?topic:q;
   for(const name of byTopic?settingsTopicNames(app):names){const candidate=scoreSearchName(needle,name);if(candidate.score>best.score)best={...candidate,matchedAgainst:name.value,nameSource:name.kind};}
   if(Object.hasOwn(userAliases,q)&&userAliases[q]===app.id&&best.score<.99)best={score:.99,auto:true,exact:true,matchedAgainst:q,nameSource:'USER_ALIAS',matchType:'USER_ALIAS'};
   if(app.resolutionRisk==='sensitive'&&!best.exact)best.auto=false;
   return {app,...best};
  }).sort((a,b)=>b.score-a.score||String(a.app.name).localeCompare(String(b.app.name))||String(a.app.id).localeCompare(String(b.app.id)));
 }
 search(query,apps,aliases={}){return this.rank(query,apps,aliases).filter(r=>r.score>=this.thresholds.candidateFloor).slice(0,10);}
 resolve(query,apps,aliases={},options={}){
  const ranked=this.rank(query,apps,aliases),first=ranked[0],runner=ranked[1],margin=first?first.score-(runner?.score||0):0,t=this.thresholds;
  const matches=ranked.filter(r=>r.score>=t.candidateFloor);
  const exactPeers=matches.filter(r=>r.exact);
  // Two exact metadata identities must never be resolved merely by score order.
  const uniqueExact=first?.matchType==='EXACT'?ranked.filter(r=>r.matchType==='EXACT').length===1:first?.exact&&exactPeers.length===1;
  const sharedShortAlias=first?.matchType!=='EXACT'&&!normalizeAppName(query).includes(' ')&&matches.slice(1).some(r=>r.partial);
  const accepted=first?.auto&&!sharedShortAlias&&(uniqueExact||!first.exact&&(first.score>=t.highConfidence&&margin>=t.highMargin||first.score>=t.mediumConfidence&&margin>=t.mediumMargin));
  const view=rows=>rows.slice(0,10).map(r=>({id:r.app.id,name:r.app.name,confidence:r.score,score:r.score,matchType:r.matchType,matchedAgainst:r.matchedAgainst,nameSource:r.nameSource,...(options.debug?{components:r.components}: {})}));
  let result;
  if(accepted)result={success:true,status:'APP_RESOLVED',code:first.exact?'MATCHED_EXACT':'MATCHED_FUZZY',app:first.app,confidence:first.score,score:first.score,matchType:first.matchType,matchedAgainst:first.matchedAgainst,margin};
  else if(first&&(first.partial||first.exact||first.auto||first.score>=t.highConfidence))result={success:false,status:'AMBIGUOUS_APP',code:'APP_AMBIGUOUS',query,confidence:first.score,score:first.score,margin,candidates:matches.slice(0,10).map(r=>r.app.name),matches:view(matches)};
  else result={success:false,status:'APP_NOT_FOUND',code:'APP_NOT_FOUND',query,score:first?.score||0,margin};
  if(options.debug)result.diagnostics={query,normalizedQuery:normalizeAppName(query),candidates:view(ranked),selected:result.app?.name||null,decision:result.success?'AUTO_OPEN':result.code,thresholds:{...t}};
  return result;
 }
 diagnose(query,apps,aliases={}){return this.resolve(query,apps,aliases,{debug:true}).diagnostics;}
}
