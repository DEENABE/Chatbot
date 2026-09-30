// Application-independent admission. No executable path is derived here.
// Windows item names that contain "and" but are one name, not two steps.
export const AND_NAMED_ITEM=/^(?:programs and features|apps and features|devices and printers)$/i;
export function appLaunchTask(message){
 const text=String(message||'').trim();
 if(/^(?:please\s+)?(?:refresh|rescan|reload) (?:the )?(?:installed )?app(?:lication)?(?:s| registry| list)?[.!]?$/i.test(text))return {tool:'app',action:'refreshAppRegistry',params:{}};
 const m=text.match(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(.+)$/i);if(!m)return null;
 const article=/^(?:the|my)\s+/i.test(m[1]);
 let query=m[1].replace(/\s+please[.!]?$/i,'').replace(/[.!?]+$/,'').replace(/^(?:the|my)\s+/i,'').replace(/\s+app$/i,'').trim();
 if(article)query=query.replace(/\s+application$/i,'');
 if(!query||query.length>200||(/[\\/:;|<>`$\x00-\x1f]/.test(query)||query.includes('&&'))||(/\b(?:and then|then|and|with arguments|script)\b/i.test(query)&&!AND_NAMED_ITEM.test(query)))return null;
 return {tool:'app',action:'openApp',params:{query}};
}
