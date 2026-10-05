// Successful paths are hints only, never authority or executable instructions.
// No field values, document text, coordinates or generated code are retained.
export class AppKnowledgeRegistry {
  constructor(){this.entries=new Map();}
  remember(appId,before,control,operation,after){
    if(before.screenFingerprint===after.screenFingerprint)return;
    const entry={appId,fingerprint:after.screenFingerprint,automationId:control.automationId||'',role:control.role,operation,provider:control.provider,successfulAt:new Date().toISOString()};
    this.entries.set(appId,entry);
    while(this.entries.size>100)this.entries.delete(this.entries.keys().next().value);
  }
  hints(appId){return this.entries.has(appId)?[{...this.entries.get(appId),requiresFreshObservation:true}]:[];}
}
