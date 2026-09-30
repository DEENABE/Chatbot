import {capabilitiesFor} from './AppCapabilities.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppDiscoveryService } from './AppDiscoveryService.js';
export class AppRegistryService {
  constructor({directory,discovery=new AppDiscoveryService(),refreshHours=Number(process.env.APP_REGISTRY_REFRESH_HOURS)||12}={}) {
    this.directory=directory; this.discovery=discovery;
    this.refreshMs=(Number.isFinite(refreshHours)&&refreshHours>0?Math.max(0.01,Math.min(refreshHours,168)):12)*3600000;
    this.apps=[]; this.aliases={}; this.scannedAt=0; this.errors=[]; this.trusted=false;
    this.ready=this.load();
  }
  async load() {
    if(!this.directory)return;
    try {const data=JSON.parse(await fs.readFile(path.join(this.directory,'app-registry.json'),'utf8'));
      if(data.schemaVersion===2 && Array.isArray(data.apps)) {this.apps=data.apps.filter(a=>a && typeof a.name==='string' && Array.isArray(a.aliases));this.scannedAt=Number(data.scannedAt)||0;this.errors=data.errors||[];}
    } catch { /* Missing/corrupt cache is recovered by discovery. */ }
    try {this.aliases=JSON.parse(await fs.readFile(path.join(this.directory,'app-aliases.json'),'utf8'));} catch {this.aliases={};}
  }
  async initialize() {
    await this.ready;
    this.timer=setInterval(()=>this.refresh().catch(()=>{}),this.refreshMs);this.timer.unref();
    await this.refresh();
  }
  close(){clearInterval(this.timer);}
  async refresh() {
    await this.ready;
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      let result;try{result=await this.discovery.discover();}catch(error){if(!this.trusted)throw error;this.errors=['discovery_unavailable'];return {count:this.apps.length,scannedAt:this.scannedAt,errors:this.errors,retained:true};}
      // A script failure leaves only code-owned capabilities; never replace a richer known list with them.
      if(result.degraded&&this.apps.some(a=>a.source!=='windows_system')){this.errors=result.errors;return {count:this.apps.length,scannedAt:this.scannedAt,errors:this.errors,retained:true};}
      const previous=new Map(this.apps.map(a=>[a.id,a]));
      this.apps=result.apps.map(a=>({...a,capabilities:capabilitiesFor(a),firstSeen:previous.get(a.id)?.firstSeen||a.lastSeen,updatedAt:new Date().toISOString()}));
      this.scannedAt=Date.now();this.errors=result.errors||[];this.trusted=true;
      if(this.directory) {
        await fs.mkdir(this.directory,{recursive:true});
        const target=path.join(this.directory,'app-registry.json'),tmp=`${target}.${randomUUID()}.tmp`;
        try {await fs.writeFile(tmp,JSON.stringify({schemaVersion:2,scannedAt:this.scannedAt,errors:this.errors,apps:this.apps}),{mode:0o600});await fs.rename(tmp,target);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
      }
      return {count:this.apps.length,scannedAt:this.scannedAt,errors:this.errors};
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  async ensureTrusted(){await this.ready;if(!this.trusted || Date.now()-this.scannedAt>this.refreshMs)await this.refresh();}
  async setUserAlias(alias,id) {
    if(!/^[\p{L}\p{N} ]{1,100}$/u.test(alias)||!this.apps.some(a=>a.id===id))throw new Error('INVALID_ALIAS');
    this.aliases[alias.toLowerCase()]=id;
    if(this.directory){await fs.mkdir(this.directory,{recursive:true});await fs.writeFile(path.join(this.directory,'app-aliases.json'),JSON.stringify(this.aliases),{mode:0o600});}
  }
}
