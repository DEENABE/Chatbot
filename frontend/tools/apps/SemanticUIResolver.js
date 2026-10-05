const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const patterns={open_folder:/\bopen folder\b/,open_file:/\bopen(?: file)?\b/,open_media:/\b(open media|open file)\b/,search:/\b(search|find)\b/,play:/^play\b/,pause:/^pause\b/,stop:/^stop\b/,volume:/\bvolume\b/,seek:/\b(seek|position)\b/,playlist:/\bplaylist\b/,equals:/\b(equal|equals)\b|^=$/,add:/\b(plus|add)\b|^\+$/,subtract:/\b(minus|subtract)\b/,multiply:/\bmultiply\b/,divide:/\bdivide\b/,read_result:/\b(result|display)\b/,terminal:/\bterminal\b/,run:/^run\b/,debug:/\bdebug\b/,save:/^save\b/};
export function inferCapabilities(controls) {
 const result=[];for(const [intent,pattern] of Object.entries(patterns)) {
  const matches=controls.filter(c=>c.enabled!==false&&pattern.test(normalize(c.name)||c.name));
  if(matches.length)result.push({intent,controls:matches.map(c=>({automationId:c.automationId,name:c.name,controlType:c.controlType})).slice(0,8),observed:true,executable:!['terminal','run','debug','save','stop'].includes(intent)});
 }
 if(controls.some(c=>/^num\dButton$/.test(c.automationId||'')))result.push({intent:'enter_number',observed:true,executable:true});
 return result;
}
export function resolveSemanticControl(goal,controls) {
 const text=normalize(goal);const intent=/folder|project/.test(text)?'open_folder':/file|document/.test(text)?'open_file':Object.keys(patterns).find(i=>patterns[i].test(text));
 const scored=controls.filter(c=>c.enabled!==false&&!c.sensitive&&!c.offscreen).map(c=>{
  const name=normalize(c.name);let confidence=name===text?1:intent&&patterns[intent].test(name)?0.94:0;
  if(!confidence){const tokens=text.split(' ').filter(w=>!['the','my','a','please'].includes(w));confidence=tokens.filter(t=>name.split(' ').includes(t)).length/Math.max(1,tokens.length)*0.8;}
  return {control:c,confidence,intent};
 }).filter(c=>c.confidence>=0.5).sort((a,b)=>b.confidence-a.confidence);
 if(!scored[0]||scored[0].confidence<0.9)return {success:false,errorCode:'LOW_MATCH_CONFIDENCE',retryable:true,candidates:scored.slice(0,5)};
 if(scored[1]&&scored[0].confidence-scored[1].confidence<0.08)return {success:false,errorCode:'AMBIGUOUS_CONTROL',retryable:false,candidates:scored.slice(0,5)};
 return {success:true,...scored[0]};
}
