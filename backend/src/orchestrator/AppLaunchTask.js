// Application-independent admission. No executable path is derived here.
// Windows item names that contain "and" but are one name, not two steps.
export const AND_NAMED_ITEM=/^(?:programs and features|apps and features|devices and printers)$/i;
// Politeness/filler around the app name. Only removes words; the remainder is still just a name to be resolved.
const LEAD=/^(?:(?:i|we)\s+(?:want|need|would like|wanna)\s+to|let'?s|help me(?:\s+to)?|(?:can|could|would|will) you(?:\s+please)?|please)\s+/i;
const TRAIL=/\s+(?:for me|right now|now|on (?:my|this) (?:pc|laptop|computer|system|machine)|in (?:my|this) (?:pc|laptop|computer|system|machine))$/i;
// "file explorer open pannu" (Tanglish): verb after the name.
const POSTFIX=/^(.+?)\s+(open|launch|start|run)\s+(?:pannu|pannunga|pannungal|pannungo|panni\s+kudu|panni\s+kudunga|seiyavum|karo)[.!]?$/i;
function normaliseRequest(text){
 const post=text.match(POSTFIX);if(post)text=`${post[2]} ${post[1]}`;
 text=text.replace(LEAD,'');
 if(/^(?:open|launch|start|run)\s/i.test(text))text=text.replace(/[.!?]+$/,'').replace(TRAIL,'').replace(/\s+please$/i,'').replace(TRAIL,'');
 return text.trim();
}
export function appLaunchTask(message){
 const text=normaliseRequest(String(message||'').trim());
 if(/^(?:please\s+)?(?:refresh|rescan|reload) (?:the )?(?:installed )?app(?:lication)?(?:s| registry| list)?[.!]?$/i.test(text))return {tool:'app',action:'refreshAppRegistry',params:{}};
 const m=text.match(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(.+)$/i);if(!m)return null;
 const article=/^(?:the|my)\s+/i.test(m[1]);
 let query=m[1].replace(/\s+please[.!]?$/i,'').replace(/[.!?]+$/,'').replace(/^(?:the|my)\s+/i,'').replace(/\s+app$/i,'').trim();
 if(article)query=query.replace(/\s+application$/i,'');
 if(!query||query.length>200||(/[\\/:;|<>`$\x00-\x1f]/.test(query)||query.includes('&&'))||(/\b(?:and then|then|and|with arguments|script)\b/i.test(query)&&!AND_NAMED_ITEM.test(query)))return null;
 return {tool:'app',action:'openApp',params:{query}};
}
