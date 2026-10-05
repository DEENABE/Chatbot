import { executionContext } from '../ExecutionContext.js';

/** Shared production wiring; the Electron broker remains the single writer. */
export function wireRepairLedger(ledger,router) {
  ledger.renewConfirmation = async (id, renewalId, scope) => {
        const record=router.gate.getRecord(id);
        if(record?.metadata.scope===scope && record.metadata.tool==='windowsRepair' && record.status==='pending')await router.services.get('windowsRepair').validateRenewal(record.metadata);
        return router.gate.renew(id,renewalId,scope);
      };
    ledger.onCancel=(scope,id)=>router.services.get('windowsRepair').auditCancellation(scope,id);
    ledger.reconcileRepair=async(scope,request,review)=>{
      if(ledger.status(scope,request.idempotencyKey).executionActive) throw Object.assign(new Error('Original execution has not stopped'),{status:409});
      return executionContext.run({...request,scope,admission:request.repair.admission},async()=>{
        const service=router.services.get('windowsRepair');
        const prior=ledger.status(scope,request.idempotencyKey);
        if(prior.reconciliation) {
          const r=prior.reconciliation;
          if(r.reviewId!==review?.reviewId || r.disposition!==review.disposition || r.note!==review.note?.trim() || review.quiescenceConfirmed!==true)throw Object.assign(new Error('Conflicting review'),{status:409});
          const record=ledger.reconcile(scope,request,{...review,data:prior.result.data});
          service.recordReconciliation({review,d:request.repair.action==='inspectSpooler'?null:service.diagnosis(request.repair.params.diagnosisId,service.context(),{fresh:false}),c:service.context()});
          return record;
        }
        const evidence=await service.reconciliationEvidence(request,review);
        const record=ledger.reconcile(scope,request,evidence.review);
        service.recordReconciliation(evidence);return record;
      });
    };
    ledger.cancelConfirmation=(id,scope)=>{
      if(router.gate.getRecord(id)?.metadata.scope!==scope)throw Object.assign(new Error('Confirmation not found'),{status:404});
      return router.gate.cancel(id);
    };
  return ledger;
}
