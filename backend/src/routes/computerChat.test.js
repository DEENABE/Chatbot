import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chanakya-computer-chat-'));
process.env.APP_DATA_PATH=directory;
const {app}=await import('../app.js');
const {config}=await import('../config.js');
const {db}=await import('../services/db.js');
const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/api`;
const registration=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'computer_test',displayName:'Computer test',password:'correcthorsebatterystaple'})});
const {token}=await registration.json();assert.ok(token);
test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(directory,{recursive:true,force:true});});
const tools=[{type:'function',function:{name:'uiAutomation_calculate',parameters:{type:'object',properties:{expression:{type:'string'}}}}}];
async function request(extra={}) {
  const response=await fetch(base+'/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({message:'Calculate 1+1 using Calculator',conversationId:'computer-test',model:config.defaultModel,tools,...extra})});
  assert.equal(response.status,200);return (await response.text()).trim().split('\n').map(s=>JSON.parse(s));
}
test('Calculator action is a tool call, without asking the model or streaming an arithmetic answer',async()=>{
  const events=await request();assert.equal(events.some(e=>e.type==='token'),false);
  assert.equal(events.find(e=>e.type==='tool_call').toolCall.function.name,'uiAutomation_calculate');
});
test('missing tool is explicitly blocked instead of answering from knowledge',async()=>{
  const events=await request({tools:[]});const answer=events.find(e=>e.type==='token').text;
  assert.match(answer,/blocked/i);assert.doesNotMatch(answer,/manually|result.*2/i);
});
test('verified Calculator evidence is returned; failed UI evidence stays failed',async()=>{
  for(const observation of [{success:true,data:{message:'Windows Calculator shows 2 for 1+1.',verification:{status:'verified'}}},{success:false,error:{code:'UI_EXECUTION_FAILED',message:'UI target unavailable'}}]){
    const events=await request({history:[{role:'user',content:'Calculate 1+1 using Calculator'},{role:'tool',tool_name:'uiAutomation_calculate',content:JSON.stringify(observation)}]});
    assert.equal(events.some(e=>e.type==='tool_call'),false);assert.equal(events.find(e=>e.type==='token').text,observation.data?.message||observation.error.message);
  }
});
test('compound chat continues through target resolution and verification with an empty continuation message',async()=>{
  const message='Open VS Code and open D:\\Projects\\Test';
  const appTools=['app_resolveTarget','app_openWithTarget'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}));
  const first=await request({message,tools:appTools});
  assert.equal(first.find(e=>e.type==='tool_call').toolCall.function.name,'app_resolveTarget');
  const target={type:'FOLDER',path:'D:\\Projects\\Test'};
  const history=[{role:'user',content:message},{role:'tool',tool_name:'app_resolveTarget',tool_call_id:'resolver',content:JSON.stringify({success:true,data:{success:true,status:'TARGET_RESOLVED',query:'D:\\Projects\\Test',target}})}];
  const next=await request({message:'',history,tools:appTools});
  assert.deepEqual(next.find(e=>e.type==='tool_call').toolCall.function.arguments,{app:'VS Code',targetFromStep:'resolver'});
  const data={success:true,status:'APP_TARGET_OPENED',target,requestedApp:'VS Code',app:{id:'code'},processId:99,verification:{status:'verified',criterion:'window_title',windowTitle:'Test - VS Code',observedAt:new Date().toISOString()},message:'Your project folder is open in Visual Studio Code.'};
  history.push({role:'tool',tool_name:'app_openWithTarget',content:JSON.stringify({success:true,data})});
  const final=await request({message:'',history,tools:appTools});assert.equal(final.find(e=>e.type==='token').text,data.message);
  data.target={type:'FOLDER',path:'D:\\Wrong'};history.at(-1).content=JSON.stringify({success:true,data});
  const wrong=await request({message:'',history,tools:appTools});assert.match(wrong.find(e=>e.type==='token').text,/not been opened and verified/);
});
