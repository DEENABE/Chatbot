import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ToolEngineRouter} from '../ToolEngineRouter.js';
import {executionContext} from '../ExecutionContext.js';
test('Windows system interfaces, dynamic Calculator, existing editor and VLC targets',{
  skip:process.platform!=='win32'||process.env.CHANAKYA_DESKTOP_GOALS_INTEGRATION!=='1',timeout:180000
},async t=>{
  const router=new ToolEngineRouter();
  const call=(tool,action,params)=>executionContext.run({authenticated:true,scope:'backend:desktop-goals-test',taskId:'desktop-goals',origin:'model'},()=>router.dispatch({tool,action,params}));
  for(const query of ['Control Panel','Settings','Device Manager','Services','Task Manager']){
    await t.test(query,async t=>{const r=await call('app','openApp',{query});assert.equal(r.permission.decision,'ALLOW');if(r.error?.code==='PERMISSION_DENIED'){t.skip(r.error.message);return;}assert.equal(r.success,true,JSON.stringify(r));});
  }
  let previous;
  for(const [expression,value] of [['1+1',2],['25+78',103],['456*23',10488],['100/4',25],['10.5+20.25',30.75]]){
    await t.test(`Calculator ${expression}`,async()=>{
    const r=await call('uiAutomation','calculate',{expression});assert.equal(r.success,true,JSON.stringify(r));
    assert.equal(Number(r.data.displayText.replaceAll(',','')),value);
    if(previous)assert.equal(r.data.processId,previous,'Reuse the open Calculator');previous=r.data.processId;
    });
  }
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'chanakya-target-'));
  // Two silent WAV files exercise target replacement without personal media.
  const audio=Buffer.alloc(44+16000*30);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);
  audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(16000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(16000*30,40);
  for(const name of ['chanakya-first.wav','chanakya-second.wav']){
    const file=path.join(folder,name);await fs.writeFile(file,audio);
    await t.test(`VLC ${name}`,async()=>{
    const r=await call('app','openWithTarget',{app:'VLC',target:{type:'MEDIA',path:file}});
    assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.verification.status,'verified');
    });
  }
  const r=await call('app','openWithTarget',{app:'VS Code',target:{type:'FOLDER',path:path.resolve('.')}});
  assert.equal(r.success,true,JSON.stringify(r));
  // Leave the tiny fixtures available while the user-visible application is open.
});
