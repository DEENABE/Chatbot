import {appLaunchTask} from './AppLaunchTask.js';
import {browserTask} from './BrowserTask.js';
import {genericDesktopTask} from './GenericDesktopTask.js';
import {freeformDesktopTask,setInstalledApps} from './FreeformDesktopTask.js';
export {setInstalledApps};
import {sameTarget,targetEvidence} from './ApplicationGoal.js';
export function compoundAppTask(message) {
  const text=String(message||'').trim();
  let m=text.match(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start)\s+(.+?)\s+(?:and(?: then)?|then)\s+(?:open|play|load)\s+(.+)$/i);
  if(m)return {app:m[1].trim(),query:m[2].trim()};
  m=text.match(/^(?:open|play)\s+(.+?)\s+(?:using|with|in)\s+(.+)$/i);
  if(m)return {app:m[2].trim(),query:m[1].trim()};
  m=text.match(/^open\s+([A-Za-z]:[\\/].+|[^\\/]+\.(?:pdf|txt|docx|xlsx|mp4|mp3))$/i);
  return m?{app:'default',query:m[1].trim()}:null;
}
/** Tool-first admission for desktop actions. This never evaluates user expressions. */
export function computerTask(message) {
  const text=String(message||'').trim();
  const browser=browserTask(text);if(browser)return {requiresTools:true,requiresBrowser:true,call:browser};
  const spoken=text.match(/(?:add|calculate) (zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (?:and|plus) (zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)/i);
  if(spoken && (/calculator/i.test(text)||/^(add|calculate) /i.test(text))){const numbers=['zero','one','two','three','four','five','six','seven','eight','nine','ten'];const n=w=>numbers.includes(w.toLowerCase())?numbers.indexOf(w.toLowerCase()):Number(w);return {requiresTools:true,requiresUI:true,call:{tool:'uiAutomation',action:'calculate',params:{expression:`${n(spoken[1])}+${n(spoken[2])}`,...(!/calculator/i.test(text)?{requireActive:true}:{})}}};}
  if(/^open settings and show bluetooth[.!]?$/i.test(text))return {requiresTools:true,call:{tool:'app',action:'openApp',params:{query:'Bluetooth Settings'}}};
  const compound=compoundAppTask(text);
  // Concrete file/URL targets keep the existing verified launch path. UI goals
  // such as opening a network-stream dialog go through the generic UI loop.
  if(compound&&(!genericDesktopTask(text)||/^(?:[A-Za-z]:[\\/]|https?:\/\/)|\.[a-z0-9]{2,5}$/i.test(compound.query)))return {requiresTools:true,requiresTarget:true,compound};
  // Troubleshooting context is not itself an instruction to mutate the desktop.
  if(/^(?:it|this|that|the (?:problem|issue))\s+(?:started|happened|appeared|occurred|was|is)\b/i.test(text) && !/\b(?:please|can you|could you)\b/i.test(text))return null;
  if (/^(?:explain|describe|what is (?:a|an)|how (?:do I|can I|to)|write (?:an? )?(?:essay|story|poem|example|tutorial))\b/i.test(text)) return null;
  if (/\bcalculator\b/i.test(text) && /\d/.test(text)) {
    const expression=text.match(/(?<![\d.(+\-*/×÷])\d+(?:\.\d+)?\s*[+\-*/×÷]\s*\d+(?:\.\d+)?(?![\d.)])/u)?.[0];
    if(expression && !/[+\-*/×÷]\s*\d/.test(text.slice(text.indexOf(expression)+expression.length)))return {requiresTools:true,requiresUI:true,call:{tool:'uiAutomation',action:'calculate',params:{expression}}};
    return {requiresTools:true,requiresUI:true};
  }
  // Notepad++ and other "notepad+..." editors are different applications from Windows Notepad.
  if(/\bnotepad\b(?!\s*\+)/i.test(text)&&/\b(?:type|write|enter)\b/i.test(text)) {
    const match=text.match(/\b(?:type|write|enter)\s+([\s\S]+?)(?:\s+(?:in|into|using)\s+(?:the\s+)?notepad)?$/i);
    if(match) {let value=match[1].trim();if(/^(["']).*\1$/s.test(value))value=value.slice(1,-1);return {requiresTools:true,requiresUI:true,call:{tool:'uiAutomation',action:'typeInNotepad',params:{text:value}}};}
  }
  const desktop=genericDesktopTask(text);
  if(desktop)return {requiresTools:true,requiresUI:true,genericDesktop:desktop};
  // Free-form wording that names an installed app in an action context enters the same verified desktop loop.
  const freeform=freeformDesktopTask(text);
  if(freeform)return {requiresTools:true,requiresUI:true,genericDesktop:freeform};
  const launch=appLaunchTask(text);if(launch)return {requiresTools:true,call:launch};
  if(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:click|double.click|press|paste|scroll|drag|minimize|maximize|close|type)\b/i.test(text))return {requiresTools:true,requiresUI:true};
  const action=/\b(?:open|launch|start|run|close|click|double.click|type|write|create|edit|set|adjust|update|paste|press|select|scroll|drag|move|resize|minimize|maximize|switch|save|delete|rename|copy|install|uninstall|change|enable|disable|refresh|read|list|show|get|check|inspect|find|search|running|installed|current|my)\b/i;
  const target=/\b(?:apps?|applications?|programs?|windows?|desktop|calculator|notepad|chrome|edge|vscode|vs code|visual studio code|files?|folders?|directories|directory|projects?|settings|buttons?|screen|computer|pc|disks?|drives?|cpu|ram|memory|processes|process|network|wifi|clipboard|taskbar|volume|brightness|bluetooth)\b|[A-Za-z]:\\|\.(?:txt|docx|pdf|xlsx|csv|pptx|json|png|jpg)\b/i;
  return action.test(text)&&target.test(text)?{requiresTools:true,requiresUI:/\b(?:click|type|paste|press|scroll|drag|window|desktop|button)\b/i.test(text)}:null;
}
export function currentToolEvidence(history) {
  let start=-1;
  for(let i=0;i<history.length;i++)if(history[i]?.role==='user')start=i;
  return history.slice(start+1).filter(h=>h?.role==='tool').map(h=>{try{return {...JSON.parse(h.content),toolName:h.tool_name,toolCallId:JSON.parse(h.content).toolCallId||h.tool_call_id};}catch{return null;}}).filter(Boolean);
}
export function executionOnlyReply(task,evidence) {
  const last=evidence.at(-1);
  if(!last)return 'Execution blocked: the model did not call a computer tool. No computer action was performed.';
  if(last.needsConfirmation)return last.confirmationMessage||'Execution is waiting for your confirmation.';
  if(last.success!==true)return last.error?.message||'The computer action failed or was blocked.';
  if(task.requiresTarget){
    const resolved=evidence.findLast(e=>e.toolName==='app_resolveTarget' && e.success && e.data?.query===task.compound.query && e.data?.status==='TARGET_RESOLVED');
    const opened=evidence.findLast(e=>e.toolName==='app_openWithTarget' && e.success && targetEvidence(e.data,resolved?.data?.target,task.compound.app));
    if(!opened)return 'The requested application target has not been opened and verified.';
    return opened.data.message||'The requested target is open in the application.';
  }
  if(task.requiresBrowser && !(last.toolName?.startsWith('browser_') && last.data?.verification?.status==='verified'))return 'The browser goal has not been verified.';
  if(task.requiresUI && !evidence.some(e=>e.success && e.data?.verification?.status==='verified' && e.toolName?.startsWith('uiAutomation_')))return 'Execution blocked: the application opened, but the requested UI action has not been performed or verified.';
  return last.data?.message||`Tool result: ${JSON.stringify(last.data??{}).slice(0,12000)}`;
}
