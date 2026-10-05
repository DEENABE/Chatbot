import fs from 'node:fs';
import path from 'node:path';
import { validSample, uuid, plain } from './contract.js';
/** Single-writer atomic audit/state snapshot. No training data is used for recovery. */
export class RepairStore {
  constructor(directory) {
    this.file = directory ? path.join(directory, 'spooler-v1.json') : null;
    this.state = { schemaVersion:1, diagnoses:{}, operations:{}, events:[] };
    if(this.file) {
      fs.mkdirSync(directory,{recursive:true});
      try { this.state=JSON.parse(fs.readFileSync(this.file,'utf8')); }
      catch(e) { if(e.code!=='ENOENT') throw e; }
    }
    if(this.state.schemaVersion!==1 || !plain(this.state.diagnoses) || !plain(this.state.operations) || !Array.isArray(this.state.events)) throw new Error('Corrupt repair journal');
    for(const [id,d] of Object.entries(this.state.diagnoses))if(!uuid(id)||d.diagnosisId!==id||!validSample(d.sample)||!Number.isFinite(d.expiresAt)||typeof d.scope!=='string'||!uuid(d.sessionId))throw new Error('Corrupt diagnosis');
    for(const [key,o] of Object.entries(this.state.operations))if(!['reserved','completed','reconciled'].includes(o.status)||!this.state.diagnoses[o.diagnosisId]||this.state.diagnoses[o.diagnosisId].operationKey!==key)throw new Error('Corrupt repair operation');
    for(const [i,event] of this.state.events.entries()) if(event.sequence!==i+1 || typeof event.eventId!=='string') throw new Error('Corrupt repair event sequence');
  }
  commit(change) {
    const next=structuredClone(this.state); change(next);
    if(this.file) {
      const fd=fs.openSync(this.file+'.tmp','w',0o600);
      try { fs.writeFileSync(fd,JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(this.file+'.tmp',this.file);
    }
    this.state=next;
  }
}
