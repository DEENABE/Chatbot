import path from 'node:path';
import {normalizeAppName as normalize} from './AppQueryNormalizer.js';
// Hosts that serve many distinct capabilities; their file name identifies none of them.
const SHARED_HOSTS=/^(?:explorer|mmc|control)$/u;
export const isSettingsPage=app=>app?.source==='windows_system'&&app.id!=='settings'&&/-settings$/.test(app.id||'');
/** Names of a Settings page without its generic "settings" suffix, matched against "X settings" queries. */
export const settingsTopicNames=app=>isSettingsPage(app)?searchNamesFor(app).map(n=>({...n,value:n.value.replace(/\s+settings?$/u,'')})).filter(n=>n.value):[];
const names=values=>[...new Set(values.filter(v=>typeof v==='string'&&v.trim()).map(normalize).filter(Boolean))];
export function searchNamesFor(app){
 const canonical=normalize(app.name||app.displayName);
 let executable=normalize(path.win32.basename(app.executablePath||app.executableName||app.executable||''));
 if(app.source&&app.source!=='start_menu'&&/^windows_|^control_panel$/.test(app.source)&&SHARED_HOSTS.test(executable))executable='';
 const metadata=names([app.displayName,app.shortcutName,app.registryDisplayName,app.startMenuName,app.packageDisplayName,app.fileDescription,app.productName,...(Array.isArray(app.discoveredNames)?app.discoveredNames:[]),...(Array.isArray(app.aliases)?app.aliases:[])]);
 const publisher=normalize(app.publisher).replace(/\s+(corporation|corp|inc|ltd|limited)$/u,'');
 const derived=[];
 for(const base of names([canonical,...metadata,executable])){
  const unversioned=base.replace(/\s+v?\d+(?:[ .]\d+)*(?:\s+(?:x64|x86|64 bit|32 bit))?$/u,'');
  if(unversioned!==base)derived.push(unversioned);
  if(publisher&&base.startsWith(publisher+' '))derived.push(base.slice(publisher.length+1));
  const tokens=base.split(' ');
  if(tokens.length>=3){derived.push(tokens.slice(0,-1).map(t=>t[0]).join('')+' '+tokens.at(-1));derived.push(tokens[0]+' '+tokens.at(-1));}
 }
 const result=new Map();
 const add=(value,kind)=>{if(value&&!result.has(value))result.set(value,{value,kind});};
 add(canonical,'NAME');
 // Executable names retain their own provenance even if discovery also cached them as aliases.
 for(const name of metadata)if(name!==executable)add(name,'METADATA');
 add(executable,'EXECUTABLE');for(const name of names(derived))add(name,'DERIVED');
 return [...result.values()];
}
export const aliasesFor=app=>searchNamesFor(app).map(n=>n.value);
export class AppSearchIndex{
 constructor(apps){
  this.entries=(Array.isArray(apps)?apps:[]).filter(app=>app?.available===true).map(app=>({app,names:searchNamesFor(app)}));
 }
}
