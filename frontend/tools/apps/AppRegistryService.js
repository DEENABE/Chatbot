import {capabilitiesFor} from './AppCapabilities.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppDiscoveryService } from './AppDiscoveryService.js';
import {appMachineIdentity} from './AppMachineIdentity.js';
import {validateTarget} from './AppTargetPolicy.js';
export class AppRegistryService {
  constructor({directory,discovery=new AppDiscoveryService(),refreshHours=Number(process.env.APP_REGISTRY_REFRESH_HOURS)||12,validationMinutes=5,machineIdentity=appMachineIdentity,validate=validateTarget}={}) {
    this.directory=directory; this.discovery=discovery;
    this.machineIdentity=machineIdentity;this.validate=validate;
    this.validationMs=(Number.isFinite(validationMinutes)&&validationMinutes>0?validationMinutes:5)*60000;
    this.validatedAt=0;
    this.refreshMs=(Number.isFinite(refreshHours)&&refreshHours>0?Math.max(0.01,Math.min(refreshHours,168)):12)*3600000;
    this.apps=[]; this.aliases={}; this.scannedAt=0; this.errors=[]; this.trusted=false;
    this.ready=this.load();
  }
  async load() {
    this.machineId=await this.machineIdentity();
    if(!this.directory)return;
    try {const data=JSON.parse(await fs.readFile(path.join(this.directory,'app-registry.json'),'utf8'));
      if(data.schemaVersion===3 && data.machineId===this.machineId && Array.isArray(data.apps)) {this.apps=data.apps.filter(a=>a && typeof a.name==='string' && Array.isArray(a.aliases));this.scannedAt=Number(data.scannedAt)||0;this.errors=Array.isArray(data.errors)?data.errors:[];this.localCache=true;}
    } catch { /* Missing/corrupt cache is recovered by discovery. */ }
    if(this.localCache)try {this.aliases=JSON.parse(await fs.readFile(path.join(this.directory,'app-aliases.json'),'utf8'));} catch {this.aliases={};}
  }
  async initialize() {
    if(this.initialization)return this.initialization;
    this.initialization=this.start();return this.initialization;
  }
  async start() {
    await this.ready;
    this.timer=setInterval(()=>this.ensureTrusted().catch(()=>{}),Math.min(this.validationMs,this.refreshMs));this.timer.unref();
    await this.refresh();
  }
  close(){clearInterval(this.timer);}
  async persist() {
    if(!this.directory)return;
    await fs.mkdir(this.directory,{recursive:true});
    const target=path.join(this.directory,'app-registry.json'),tmp=`${target}.${randomUUID()}.tmp`;
    try {await fs.writeFile(tmp,JSON.stringify({schemaVersion:3,machineId:this.machineId,scannedAt:this.scannedAt,validatedAt:this.validatedAt,errors:this.errors,apps:this.apps}),{mode:0o600});await fs.rename(tmp,target);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
  }
  async validateEntries(){
    if(this.pending)await this.pending;
    let invalidated=0;
    for(const app of this.apps){
      if(!app.available)continue;
      try {this.validate(app);}catch(error){app.available=false;app.blockedReason=error.message;invalidated++;}
    }
    this.validatedAt=Date.now();
    if(invalidated)await this.persist();
    return {invalidated,validatedAt:this.validatedAt};
  }
  async refresh({query}={}) {
    await this.ready;
    if(this.pending){const activeQuery=this.pendingQuery,result=await this.pending;return query===activeQuery?result:this.refresh({query});}
    // A targeted scan augments an already verified local snapshot. First launch always scans all sources.
    if(!this.trusted)query=undefined;
    this.pendingQuery=query;
    this.pending=(async()=>{
      let result;try{result=await this.discovery.discover(query?{query}:{});}catch(error){if(!this.trusted)throw error;this.errors=['discovery_unavailable'];return {count:this.apps.length,scannedAt:this.scannedAt,errors:this.errors,retained:true};}
      // A script failure leaves only code-owned capabilities; never replace a richer known list with them.
      if(result.degraded&&this.trusted&&this.apps.some(a=>a.source!=='windows_system')){this.errors=result.errors;return {count:this.apps.length,scannedAt:this.scannedAt,errors:this.errors,retained:true};}
      const previous=new Map(this.apps.map(a=>[a.id,a]));
      const discovered=result.apps.map(a=>({...a,capabilities:capabilitiesFor(a),firstSeen:previous.get(a.id)?.firstSeen||a.lastSeen,updatedAt:new Date().toISOString()}));
      if(query){for(const app of discovered)previous.set(app.id,app);this.apps=[...previous.values()];}
      else this.apps=discovered;
      // Discovery validates each target. The next cheap validation is due in validationMs.
      if(!query){this.scannedAt=Date.now();this.validatedAt=this.scannedAt;}
      this.errors=query?[...new Set([...this.errors,...(result.errors||[])])]:result.errors||[];this.trusted=true;
      await this.persist();
      return {count:this.apps.length,scannedAt:this.scannedAt,errors:this.errors,targeted:!!query};
    })();
    try{return await this.pending;}finally{this.pending=null;this.pendingQuery=undefined;}
  }
  async ensureTrusted(){await this.ready;if(!this.trusted || Date.now()-this.scannedAt>this.refreshMs)await this.refresh();else if(Date.now()-this.validatedAt>this.validationMs)await this.validateEntries();}
  async setUserAlias(alias,id) {
    if(!/^[\p{L}\p{N} ]{1,100}$/u.test(alias)||!this.apps.some(a=>a.id===id))throw new Error('INVALID_ALIAS');
    this.aliases[alias.toLowerCase()]=id;
    if(this.directory){await fs.mkdir(this.directory,{recursive:true});await fs.writeFile(path.join(this.directory,'app-aliases.json'),JSON.stringify(this.aliases),{mode:0o600});}
  }
}
