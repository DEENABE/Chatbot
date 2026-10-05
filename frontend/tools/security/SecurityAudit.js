import fs from 'node:fs';
import path from 'node:path';
import { parameterHash } from './ToolRequestValidator.js';
/** Explicit projection: never serialize requests, parameters, tokens or output. */
export class SecurityAudit {
  constructor(directory, {maxBytes=5*1024*1024,retainedFiles=5}={}) {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<256||!Number.isInteger(retainedFiles)||retainedFiles<1||retainedFiles>20)throw new Error('Invalid audit retention policy');
    this.maxBytes=maxBytes;this.retainedFiles=retainedFiles;
    if (directory) { fs.mkdirSync(directory,{recursive:true}); this.file=path.join(directory,'tool-security.jsonl'); }
    this.events=[];
  }
  append(line) {
    let size=0;
    try {size=fs.statSync(this.file).size;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(size+Buffer.byteLength(line)>this.maxBytes && size>0) {
      // One Electron audit writer; fixed names never come from tool parameters.
      for(let n=this.retainedFiles;n>=1;n--) {
        const target=`${this.file}.${n}`,source=n===1?this.file:`${this.file}.${n-1}`;
        if(n===this.retainedFiles)fs.rmSync(target,{force:true});
        if(fs.existsSync(source))fs.renameSync(source,target);
      }
    }
    fs.appendFileSync(this.file,line,{mode:0o600});
  }
  record(request, context, decision, status, approvalReference = null, outcome = null) {
    const event = { timestamp:new Date().toISOString(), requestId:context?.requestId ?? null, userId:context?.scope ?? null, taskId:context?.taskId ?? null,
      tool:decision.auditMetadata?.tool ?? null, action:decision.auditMetadata?.tool?.split('.')[1] ?? null, risk:decision.risk, decision:decision.decision, reasonCode:decision.reasonCode, resultStatus:status, approvalReference,
      paramsHash:decision.decision!=='DENY' && decision.risk==='DANGEROUS' ? parameterHash(request.params??{}) : null };
    if(outcome){const d=outcome.data||{};event.appId=/^[a-zA-Z0-9-]{1,64}$/.test(d.appId||d.app?.id||'')?(d.appId||d.app.id):null;event.matchConfidence=Number.isFinite(d.matchConfidence)?d.matchConfidence:null;event.strategy=['UI_AUTOMATION','NATIVE_ARGUMENT','TRUSTED_SYSTEM','DISCOVERED_EXECUTABLE'].includes(d.strategy)?d.strategy:d.verification?.criterion==='browser_dom'?'BROWSER_DOM':null;event.step=Number.isSafeInteger(context?.step)?context.step:null;}
    if (this.file) this.append(JSON.stringify(event)+'\n');
    this.events.push(event); if(this.events.length>1000)this.events.shift();
  }
}
