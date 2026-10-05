import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ToolEngineRouter} from '../ToolEngineRouter.js';
import {executionContext} from '../ExecutionContext.js';
import {runOrchestrator} from '../../../backend/src/orchestrator/AgentOrchestrator.js';

test('real compound goals pass through planner, state, permission, Windows and goal verifier',{
  skip:process.platform!=='win32'||process.env.CHANAKYA_COMPOUND_INTEGRATION!=='1',timeout:180000
},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chanakya-compound-'));
  const folders=[path.join(directory,'FirstProject'),path.join(directory,'SecondProject')];
  for(const folder of folders)await fs.mkdir(folder);
  const media=[path.join(directory,'first-silent.wav'),path.join(directory,'second-silent.wav')];
  const audio=Buffer.alloc(44+16000*30);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(16000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40);
  for(const file of media)await fs.writeFile(file,audio);
  const router=new ToolEngineRouter();
  router.services.get('app').targetAliases={'my project':{type:'FOLDER',path:folders[0]},'my project folder':{type:'FOLDER',path:folders[0]},'this movie':{type:'MEDIA',path:media[0]}};
  const dependencies={save:()=>{},createLogger:()=>({log:()=>{}}),executeStep:step=>executionContext.run({authenticated:true,scope:'backend:compound-integration',taskId:'compound-integration',origin:'model'},()=>router.dispatch({tool:step.tool,action:step.action,params:step.params,toolCallId:step.toolCallId,requestId:step.requestId,idempotencyKey:step.idempotencyKey}))};
  for(const task of ['Open VS Code','Open VLC','Open vscoed and open my project',`Open VS Code and open ${folders[1]}`,'Open vlcc and play this movie',`Play ${media[1]} using VLC`]) {
    await t.test(task,async()=>{
      const events=[];const result=await runOrchestrator({task,maxRetries:0,dependencies,onEvent:event=>events.push(event)});
      assert.equal(result.phase,'done',JSON.stringify({result,observations:events.filter(e=>e.type==='step_result')}));
      const outcomes=events.filter(e=>e.type==='step_result');
      if(task.includes(' and ')||task.startsWith('Play ')) {
        assert.equal(outcomes.length,2);assert.equal(outcomes[0].payload.data.status,'TARGET_RESOLVED');
        assert.equal(outcomes[1].payload.data.status,'APP_TARGET_OPENED');assert.equal(outcomes[1].payload.permission.decision,'ALLOW');
        assert.match(result.summary,/is open in/);
      }
    });
  }
  t.diagnostic(`Test targets retained for the open applications: ${directory}`);
});
