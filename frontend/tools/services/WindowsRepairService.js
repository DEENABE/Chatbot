import { randomUUID, createHash } from 'node:crypto';
import { executionContext } from '../ExecutionContext.js';
import { RepairStore } from '../repair/RepairStore.js';
import { CAPABILITY, POLICY_VERSION, LIMITS, validateRepair, validSample, eligibility, sameMachine, verified, uuid } from '../repair/contract.js';
const fail=(code,message=code)=>{throw Object.assign(new Error(message),{code});};
const hash=v=>createHash('sha256').update(v).digest('hex');
export class WindowsRepairService {
  constructor(gate,{directory,runner,now=Date.now}={}) {
    this.gate=gate; this.store=new RepairStore(directory); this.runner=runner; this.now=now;
    gate.observeRepairRecord=record=>{
      const m=record.metadata;
      if(record.status==='superseded') return;
      const c={scope:m.scope,operationKey:m.operationKey,admission:m.admission,requestId:m.requestId,toolCallId:m.toolCallId,idempotencyKey:m.idempotencyKey};
      this.store.commit(s=>this.event(s,c,record.status==='consumed'?'confirmation.approved':record.status==='cancelled'?'confirmation.rejected':record.generation?'confirmation.renewed':'confirmation.requested',{diagnosisId:m.params.diagnosisId,approvalRootId:hash(record.rootId),approvalGeneration:record.generation}));
    };
  }
  context() {
    const c=executionContext.getStore(); const a=c?.admission;
    if(!c?.scope?.startsWith('backend:') || !a || !uuid(a.sessionId) || a.taskType!=='windows_repair_print_spooler_start' || !Number.isInteger(a.revision) || a.revision<1 || !c.requestId?.startsWith(a.sessionId+':request:')) fail('REPAIR_ADMISSION_REQUIRED');
    c.signal?.throwIfAborted();
    return {...c,operationKey:`${a.sessionId}:${CAPABILITY}`};
  }
  event(state,c,type,fields={}) {
    const d=Object.values(state.diagnoses).find(d=>d.operationKey===c.operationKey);
    state.events.push({schemaVersion:1,eventId:randomUUID(),sequence:state.events.length+1,sessionSequence:state.events.filter(e=>e.sessionId===c.admission.sessionId).length+1,eventType:type,timestamp:new Date(this.now()).toISOString(),sessionId:c.admission.sessionId,admittedStateRevision:c.admission.revision,attemptId:c.requestId,ownerId:c.scope,hostId:d?.sample.hostId??null,bootId:d?.sample.bootId??null,capabilityId:CAPABILITY,capabilityVersion:1,policyVersion:POLICY_VERSION,runnerDigest:d?.sample.runnerDigest??null,operationKey:c.operationKey,requestId:c.requestId,toolCallId:c.toolCallId,idempotencyKey:c.idempotencyKey,diagnosisId:d?.diagnosisId??null,approvalRootId:null,approvalGeneration:null,effectStatus:state.operations[c.operationKey]?.status??'not_dispatched',evidenceRefs:d?[d.diagnosisId]:[],errorCode:null,nativeErrorCode:null,provenance:'machine_observation',...fields});
  }
  diagnosis(id,c,{fresh=true}={}) {
    const d=this.store.state.diagnoses[id];
    if(!d || d.scope!==c.scope || d.sessionId!==c.admission.sessionId) fail('DIAGNOSIS_NOT_FOUND');
    if(fresh && (this.now()>=d.expiresAt || this.now()<d.createdAt)) fail('REQUIRES_REDIAGNOSIS');
    return d;
  }
  async execute(action,params) {
    const invalid=validateRepair(action,params); if(invalid) fail('VALIDATION_ERROR',invalid);
    const c=this.context();
    if(action==='inspectSpooler') {
      const sample=await this.runner('inspect',{signal:c.signal});
      if(!validSample(sample)) fail('INVALID_EVIDENCE');
      const id=randomUUID(), createdAt=this.now(), reason=eligibility(sample);
      const d={diagnosisId:id,scope:c.scope,sessionId:c.admission.sessionId,operationKey:c.operationKey,createdAt,expiresAt:createdAt+LIMITS.eligibilityMs,policyVersion:POLICY_VERSION,sample,eligible:reason===null,reason};
      this.store.commit(s=>{s.diagnoses[id]=d;this.event(s,c,'diagnosis.completed',{diagnosisId:id,hostId:sample.hostId,bootId:sample.bootId,reason});});
      return {success:true,data:d};
    }
    const d=this.diagnosis(params.diagnosisId,c,{fresh:action==='startSpooler'});
    if(action==='verifySpooler') return this.verify(d,c);
    if(!d.eligible) fail(d.reason);
    if(this.store.state.operations[c.operationKey]) fail('OPERATION_ALREADY_RESERVED');
    const records=Object.values(this.gate.records).filter(r=>r.metadata?.operationKey===c.operationKey);
    if(records.some(r=>['consumed','cancelled'].includes(r.status))) fail('APPROVAL_ALREADY_SPENT');
    const existing=records.find(r=>r.status==='pending');
    let token;
    const message='Start the local Print Spooler? Existing queued documents may print, and Windows may activate configured dependencies. No jobs or startup settings will be changed. Cancellation after Windows accepts the start may not stop the service. Printing itself is not verified.';
    if(existing) token={confirmationId:existing.confirmationId,expiresAt:existing.expiresAt};
    else {
      this.store.commit(s=>this.event(s,c,'repair.proposed',{diagnosisId:d.diagnosisId}));
      token=this.gate.request({tool:'windowsRepair',action,params,scope:c.scope,message,operationKey:c.operationKey,sessionId:c.admission.sessionId,admission:c.admission,requestId:c.requestId,toolCallId:c.toolCallId,idempotencyKey:c.idempotencyKey,diagnosisDigest:hash(JSON.stringify(d)),validUntil:d.expiresAt,maxRenewals:LIMITS.renewals});
    }
    return {success:true,needsConfirmation:true,...token,promise:undefined,message};
  }
  async executeConfirmed(action,params,metadata) {
    if(action!=='startSpooler' || validateRepair(action,params)) fail('VALIDATION_ERROR');
    const c=this.context(),d=this.diagnosis(params.diagnosisId,c);
    if(c.humanApproved!==true || metadata?.operationKey!==c.operationKey || metadata.diagnosisDigest!==hash(JSON.stringify(d))) fail('HUMAN_APPROVAL_REQUIRED');
    if(this.store.state.operations[c.operationKey]) fail('OPERATION_ALREADY_RESERVED');
    if(Object.values(this.store.state.operations).some(o=>o.hostId===d.sample.hostId && o.status==='reserved')) fail('EARLIER_EFFECT_UNCERTAIN');
    // Revalidation happens after token consumption; a stale token can never be recycled.
    const before=await this.runner('inspect',{signal:c.signal});
    const reason=eligibility(before);
    const invalid=!sameMachine(before,d.sample)?'PRECONDITION_CHANGED':reason && reason!=='ALREADY_RUNNING'?reason:null;
    if(invalid){this.store.commit(s=>this.event(s,c,'repair.precondition_failed',{errorCode:invalid}));fail(invalid);}
    c.signal?.throwIfAborted();
    // Reserve after the last await. Every concurrent continuation sees this durable record.
    if(this.store.state.operations[c.operationKey]) fail('OPERATION_ALREADY_RESERVED');
    if(Object.values(this.store.state.operations).some(o=>o.hostId===d.sample.hostId && o.status==='reserved')) fail('EARLIER_EFFECT_UNCERTAIN');
    this.store.commit(s=>{s.operations[c.operationKey]={status:'reserved',hostId:d.sample.hostId,diagnosisId:d.diagnosisId,scope:c.scope,before,requestId:c.requestId,admission:c.admission,toolCallId:c.toolCallId,idempotencyKey:c.idempotencyKey,startedAt:this.now()};this.event(s,c,'repair.dispatch_reserved',{diagnosisId:d.diagnosisId,hostId:before.hostId,bootId:before.bootId});});
    try {
      const result=reason==='ALREADY_RUNNING'?{startDisposition:'not_dispatched',alreadyRunning:true}:await this.runner('start',{signal:c.signal,expected:d.sample});
      if(!result || !['accepted','not_dispatched','rejected'].includes(result.startDisposition)) fail('EXECUTION_UNCERTAIN');
      this.store.commit(s=>{Object.assign(s.operations[c.operationKey],{status:'completed',result});this.event(s,c,'repair.start_returned',{startDisposition:result.startDisposition,nativeErrorCode:result.nativeErrorCode??null});});
      return {success:result.startDisposition!=='rejected',data:{...result,diagnosisId:d.diagnosisId,userIssueResolved:null},...(result.startDisposition==='rejected'?{error:{code:'START_REJECTED',message:'Windows rejected the start.'}}:{})};
    } catch(e) {
      // Keep reservation spent even if helper death or journal failure obscures the result.
      try { this.store.commit(s=>this.event(s,c,'repair.effect_uncertain',{errorCode:e.code||'HELPER_FAILED'})); } catch {}
      fail('EXECUTION_UNCERTAIN','The start may have reached Windows. Inspect and reconcile; do not retry.');
    }
  }
  async verify(d,c) {
    const result=await this.runner('verify',{signal:c.signal,expected:d.sample});
    const pass=verified(result?.samples,d.sample) && result.samples[0].observedAt>=this.now()-LIMITS.verifyMs-1000 && result.samples[1].observedAt<=this.now()+1000;
    const op=this.store.state.operations[c.operationKey];
    const data={diagnosisId:d.diagnosisId,verificationStatus:pass?'passed':'failed',verificationScope:'service_running',samples:result?.samples||[],baseline:d.sample,outcome:pass?(op?.result?.startDisposition==='accepted'?'started_verified':'already_satisfied'):'failed',attribution:op?.result?.startDisposition==='accepted'?'recorded_start':'unknown',userIssueResolved:null};
    this.store.commit(s=>{if(s.operations[c.operationKey]) s.operations[c.operationKey].verification=data;for(const sample of data.samples)this.event(s,c,'verification.sample',{sample});this.event(s,c,'verification.result',{diagnosisId:d.diagnosisId,verificationStatus:data.verificationStatus,samples:data.samples,provenance:'machine_observation'});});
    return {success:pass,data,...(!pass?{error:{code:'POSTCONDITION_FAILED',message:'Spooler running condition was not verified.'}}:{})};
  }
  getActionList() {return [{action:'inspectSpooler',schema:{},destructive:false,description:'Inspect the local Print Spooler'},{action:'startSpooler',schema:{diagnosisId:{type:'string',required:true}},destructive:true,description:'Start an eligible stopped Print Spooler after approval'},{action:'verifySpooler',schema:{diagnosisId:{type:'string',required:true}},destructive:false,description:'Verify only the Spooler running condition'}];}
  async reconciliationEvidence(request,review) {
    const c=this.context();
    if(!review || review.quiescenceConfirmed!==true || !['completed','not_completed','abandon'].includes(review.disposition)) fail('INVALID_REVIEW');
    if(request.repair?.action==='inspectSpooler') {
      if(review.disposition==='completed') fail('READ_ONLY_DIAGNOSIS_REQUIRES_NEW_SESSION');
      return {review:{...review,data:null},d:null,c};
    }
    const d=this.diagnosis(request.repair?.params?.diagnosisId,c,{fresh:false});
    if(review.disposition!=='completed') return {review:{...review,data:null},d,c};
    const result=await this.verify(d,c);
    if(!result.success) fail('POSTCONDITION_FAILED');
    return {review:{...review,data:result.data},d,c};
  }
  recordReconciliation({review,d,c}) {
    if(this.store.state.events.some(e=>e.operationKey===c.operationKey&&e.eventType==='reconciliation.recorded'&&e.reviewId===review.reviewId))return;
    this.store.commit(s=>{const op=s.operations[c.operationKey];if(op)op.status='reconciled';this.event(s,c,'reconciliation.recorded',{diagnosisId:d?.diagnosisId??null,reviewId:review.reviewId,disposition:review.disposition,provenance:'human_attestation'});});
  }
  async validateRenewal(metadata) {
    const c={scope:metadata.scope,admission:metadata.admission,operationKey:metadata.operationKey};
    const d=this.diagnosis(metadata.params.diagnosisId,c);
    if(this.store.state.operations[c.operationKey])fail('OPERATION_ALREADY_RESERVED');
    const sample=await this.runner('inspect',{signal:AbortSignal.timeout(LIMITS.diagnosisMs)});
    if(!sameMachine(sample,d.sample)||eligibility(sample))fail('REQUIRES_REDIAGNOSIS');
  }
  auditCancellation(scope,requestId) {
    const entry=Object.entries(this.store.state.operations).find(([,o])=>o.scope===scope&&o.requestId===requestId);
    if(entry){const [operationKey,op]=entry;this.store.commit(s=>this.event(s,{...op,operationKey},'cancellation.requested'));}
  }
}
