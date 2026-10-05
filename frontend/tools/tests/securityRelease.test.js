import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SecurityAudit} from '../security/SecurityAudit.js';
test('audit retention bounds disk archives and preserves valid metadata-only JSON',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'audit-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const audit=new SecurityAudit(root,{maxBytes:512,retainedFiles:2});
  for(let i=0;i<12;i++)audit.record({params:{}},{scope:'backend:user',taskId:'task',requestId:String(i)},{decision:'ALLOW',risk:'READ',reasonCode:'POLICY_ALLOWED',auditMetadata:{tool:'hardware.systemInfo'}},'completed');
  const files=fs.readdirSync(root);assert.equal(files.length,3);
  for(const file of files)for(const line of fs.readFileSync(path.join(root,file),'utf8').trim().split('\n'))assert.equal(JSON.parse(line).risk,'READ');
  assert.equal(audit.events.length,12);
});
