import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
export const INSPECTION_DEFAULTS=Object.freeze({maxDepth:12,maxElements:1000,timeoutMs:5000,debug:false});
const failure=(error,extra={})=>({success:false,provider:'WindowsUIA',error,windows:[],rawElementCount:0,skippedElementCount:0,...extra});
/** Persistent JSON-lines transport. Contains no desktop input or pattern actions. */
export class WindowsUIAProvider{
 constructor({helperPath=fileURLToPath(new URL('./native/bin/WindowsUIAHost.exe',import.meta.url))}={}){
  this.helperPath=helperPath;this.child=null;this.pending=null;this.queue=Promise.resolve();this.closed=false;this.starts=0;this.queued=0;
 }
 inspect(target,options={}){
  if(this.closed)return Promise.resolve(failure('UIA_CONNECTION_FAILED'));
  if(this.queued>=16)return Promise.resolve(failure('UIA_CONNECTION_FAILED'));
  this.queued++;const result=this.queue.then(()=>this.request(target,options));this.queue=result.catch(()=>{});return result.finally(()=>this.queued--);
 }
 start(){
  if(this.child&&!this.child.killed)return;
  if(process.platform!=='win32'||!fs.existsSync(this.helperPath))throw Error('UIA_CONNECTION_FAILED');
  if(this.helperPath.split(/[\\/]/).some(p=>p.endsWith('.asar')))throw Error('UIA_CONNECTION_FAILED');
  const child=spawn(this.helperPath,[],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});this.child=child;this.starts++;let buffer='';
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
   buffer+=chunk;if(Buffer.byteLength(buffer,'utf8')>8*1024*1024){this.abort(child,'UIA_CONNECTION_FAILED');return;}
   let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line)continue;
    let result;try{result=JSON.parse(line);}catch{this.abort(child,'UIA_CONNECTION_FAILED');return;}
    const pending=this.pending;if(pending?.child!==child||result.id!==pending.id){this.abort(child,'UIA_CONNECTION_FAILED');return;}
    if(result.error==='UIA_INSPECTION_TIMEOUT'){if(this.child===child)this.child=null;child.kill();}
    this.finish(result);
   }
  });
  // Never forward arbitrary native exception details or UI text to normal logs.
  child.stderr.resume();child.stdin.on('error',()=>this.abort(child,'UIA_CONNECTION_FAILED'));
  child.on('error',()=>this.abort(child,'UIA_CONNECTION_FAILED'));
  child.on('exit',()=>{if(this.child===child)this.child=null;if(this.pending?.child===child)this.finish(failure('UIA_CONNECTION_FAILED'));});
 }
 finish(result){const pending=this.pending;if(!pending)return;this.pending=null;clearTimeout(pending.timer);pending.resolve(result);}
 abort(child,error){if(this.child===child)this.child=null;if(this.pending?.child===child)this.finish(failure(error));child.kill();}
 request(target,options){
  if(this.closed)return failure('UIA_CONNECTION_FAILED');
  const opts={...INSPECTION_DEFAULTS,...options};
  if(!target||!Number.isSafeInteger(target.processId)||target.processId<=0)return failure('TARGET_PROCESS_NOT_FOUND');
  if(typeof target.windowHandle!=='string'||!/^\d+$/.test(target.windowHandle)||BigInt(target.windowHandle)<=0n||BigInt(target.windowHandle)>9223372036854775807n)return failure('TARGET_WINDOW_NOT_FOUND');
  if(typeof target.executablePath!=='string'||!path.win32.isAbsolute(target.executablePath))return failure('UIA_CONNECTION_FAILED');
  for(const [key,min,max] of [['maxDepth',0,32],['maxElements',1,5000],['timeoutMs',100,30000]])if(!Number.isInteger(opts[key])||opts[key]<min||opts[key]>max)return failure('UIA_CONNECTION_FAILED');
  const cleanTarget={applicationName:String(target.applicationName||'').slice(0,300),processId:target.processId,windowHandle:target.windowHandle,executablePath:target.executablePath,...(target.appUserModelId?{appUserModelId:target.appUserModelId}:{}),...(target.packageFamilyName?{packageFamilyName:target.packageFamilyName}:{})};
  try{this.start();}catch{return failure('UIA_CONNECTION_FAILED');}
  return new Promise(resolve=>{
   const child=this.child,id=randomUUID();const timer=setTimeout(()=>this.abort(child,'UIA_INSPECTION_TIMEOUT'),opts.timeoutMs+1500);
   this.pending={id,child,timer,resolve};child.stdin.write(JSON.stringify({id,target:cleanTarget,options:opts})+'\n');
  });
 }
 async close(){this.closed=true;await this.queue;const child=this.child;this.child=null;if(!child)return;await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();});}
}
