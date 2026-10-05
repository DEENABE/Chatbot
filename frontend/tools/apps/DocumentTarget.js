import fs from 'node:fs/promises';
import path from 'node:path';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const targetSchema={type:{type:'string',required:true,maxLength:20},path:{type:'string',maxLength:4096},value:{type:'string',maxLength:4096}};
export async function resolveDocumentTarget(target) {
  if(!target || typeof target!=='object' || Array.isArray(target) || ![Object.prototype,null].includes(Object.getPrototypeOf(target)) || Object.keys(target).some(k=>!['type','path','value'].includes(k)))fail('TARGET_TYPE_UNSUPPORTED');
  const type=String(target.type).toUpperCase();
  if(type==='URL') {
    if(typeof target.value!=='string'||target.value.length>4096||/[\x00-\x1f]/.test(target.value)||target.path!==undefined)fail('TARGET_TYPE_UNSUPPORTED');
    let url;try{url=new URL(target.value);}catch{fail('TARGET_TYPE_UNSUPPORTED');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('TARGET_TYPE_UNSUPPORTED');
    return {type,value:url.href};
  }
  if(!['FILE','FOLDER','MEDIA','WORKSPACE','DOCUMENT','UNKNOWN'].includes(type))fail('TARGET_TYPE_UNSUPPORTED');
  if(target.value!==undefined)fail('TARGET_TYPE_UNSUPPORTED');
  const p=target.path;
  if(typeof p!=='string'||! /^[A-Za-z]:[\\/]/.test(p)||/[\x00-\x1f"<>|?*]/.test(p)||p.slice(2).includes(':')||p.split(/[\\/]/).includes('..'))fail('TARGET_NOT_FOUND');
  let real,stat;try{real=await fs.realpath(p);stat=await fs.stat(real);}catch{fail('TARGET_NOT_FOUND');}
  if(!/^[A-Za-z]:[\\/]/.test(real))fail('TARGET_TYPE_UNSUPPORTED');
  if(/\.(exe|com|bat|cmd|ps1|msi|msp|scr|lnk|url|vbs|js|hta|reg|msc)$/i.test(real))fail('TARGET_TYPE_UNSUPPORTED');
  if((type==='FOLDER'&&!stat.isDirectory())||(type!=='FOLDER'&&type!=='UNKNOWN'&&!stat.isFile())||(!stat.isFile()&&!stat.isDirectory()))fail('TARGET_TYPE_UNSUPPORTED');
  return {type:type==='UNKNOWN'?(stat.isDirectory()?'FOLDER':'FILE'):type,path:path.win32.normalize(real)};
}
