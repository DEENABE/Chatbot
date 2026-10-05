import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatExecution } from '../../../frontend/src/services/chatExecution.js';

test('chat renewal retains the exact execution and requires a separate approval',async()=>{
  const originalWindow=globalThis.window, originalStorage=globalThis.localStorage;
  let renewCalls=0,confirmCalls=0;
  globalThis.window={addEventListener(){},toolEngine:{renewConfirmation:async(id,renewalId)=>{
    renewCalls++;assert.equal(id,'old');assert.ok(renewalId);
    return {previousId:'old',confirmationId:'new',expiresAt:Date.now()+60000,message:'Approve unchanged action again.'};
  },confirm:async()=>{confirmCalls++;}}};
  globalThis.localStorage={getItem:()=>null,setItem(){}};
  try {
    const {useAppStore}=await import('../../../frontend/src/stores/useAppStore.js');
    const execution=createChatExecution('test',{save:()=>{}});execution.plan([{tool:'process',action:'startProcess',params:{command:'notepad'},toolCallId:'model'}]);
    await execution.execute(async()=>({needsConfirmation:true,confirmationId:'old'}));
    useAppStore.setState({pendingConfirmations:[{confirmationId:'old',execution,message:'Original action.'}]});
    await useAppStore.getState().renewConfirmation('old');
    assert.equal(renewCalls,1);assert.equal(confirmCalls,0);assert.equal(execution.state.phase,'waiting_confirmation');assert.equal(execution.state.stepCount,1);
    assert.equal(useAppStore.getState().pendingConfirmations[0].confirmationId,'new');
    assert.equal(execution.state.plan[0].toolCallId,'model');
  } finally {globalThis.window=originalWindow;globalThis.localStorage=originalStorage;}
});
