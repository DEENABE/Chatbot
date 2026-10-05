import {test} from 'node:test';
import assert from 'node:assert/strict';
test('repair UI renews checkpoint then separately approves using its new revision',async()=>{
 const oldWindow=globalThis.window,oldStorage=globalThis.localStorage;
 globalThis.window={addEventListener(){}};globalThis.localStorage={getItem:()=>null,setItem(){}};
 try {
  const {useAppStore}=await import('../../../frontend/src/stores/useAppStore.js');const {repair}=await import('../../../frontend/src/services/api.js');
  const originals={...repair};let approvals=0,cancellations=0;
  try {
   repair.renew=async(id,body)=>{assert.equal(id,'session');assert.equal(body.expectedRevision,5);return {data:{revision:6,state:{currentStepIndex:0,plan:[{observation:{confirmationId:'new-token',confirmationMessage:'Approve start.'}}]}}};};
   repair.resume=async(id,body,signal)=>{approvals++;assert.equal(id,'session');assert.equal(body.expectedRevision,6);assert.equal(body.confirmationId,'new-token');assert.equal(signal.aborted,false);return {data:{summary:'Print Spooler is running; printing has not been verified.'}};};
   repair.cancel=async()=>{cancellations++;return {data:{cancelled:true}};};
   useAppStore.setState({activeMessages:[{id:'message',content:''}],pendingConfirmations:[{confirmationId:'old-token',messageId:'message',repair:{sessionId:'session',revision:5,requestId:'request'}}]});
   await useAppStore.getState().renewConfirmation('old-token');assert.equal(approvals,0);
   await useAppStore.getState().resolveConfirmation('new-token',true);assert.equal(approvals,1);assert.equal(useAppStore.getState().pendingConfirmations.length,0);assert.equal(useAppStore.getState().isGenerating,false);
   assert.match(useAppStore.getState().activeMessages[0].content,/printing has not been verified/);
   useAppStore.setState({pendingConfirmations:[{confirmationId:'decline',repair:{sessionId:'session',revision:6,requestId:'request'}}]});
   await useAppStore.getState().resolveConfirmation('decline',false);assert.equal(cancellations,1);assert.equal(approvals,1);
  } finally {Object.assign(repair,originals);}
 } finally {globalThis.window=oldWindow;globalThis.localStorage=oldStorage;}
});
