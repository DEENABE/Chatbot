import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {projectTypedRepair} from './TypedRepairProjection.js';
process.env.APP_DATA_PATH=fs.mkdtempSync(path.join(os.tmpdir(),'typed-repair-history-'));
const logger=await import('./RepairLogger.js');
const state={sessionId:'test-session',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),ownerId:'owner',task:'printing is broken',phase:'done',revision:20,verdict:{summary:'Print Spooler is running; printing has not been verified.'},plan:[{action:'verifySpooler'}],attempts:[{request:{tool:'windowsRepair',action:'verifySpooler',toolCallId:'call',requestId:'request',params:{diagnosisId:'diagnosis'},confirmationId:'SECRET'},observation:{success:true,data:{verificationStatus:'passed',diagnosisId:'diagnosis',secret:'SECRET'}}}]};
test('typed projection preserves machine outcome separately and excludes approval secrets',()=>{
 const record=projectTypedRepair(state);assert.equal(record.machineVerification.status,'passed');assert.equal(record.resolved,false);assert.equal(record.userIssueResolved,null);assert.equal(record.auditEvent.eventType,'session.completed');assert.doesNotMatch(JSON.stringify(record),/SECRET|PowerShell/);
});
test('typed history upserts by checkpoint revision and owned feedback cannot rewrite verification',()=>{
 logger.logTypedRepair(state);assert.equal(logger.addFeedback(state.sessionId,false,'still cannot print','other'),false);
 assert.equal(logger.addFeedback(state.sessionId,false,'still cannot print','owner'),true);
 logger.logTypedRepair({...state,revision:21});logger.logTypedRepair({...state,revision:19,phase:'error'});
 const records=logger.getSessions();assert.equal(records.length,1);assert.equal(records[0].revision,21);assert.equal(records[0].feedback.worked,false);assert.equal(records[0].machineVerification.status,'passed');
 const examples=logger.exportTrainingDataSplit().repair;assert.equal(examples.length,1);assert.match(examples[0].messages[1].content,/printing has not been verified/);assert.doesNotMatch(JSON.stringify(examples),/Start-Service|powershell.exe|SECRET/);
});
test('typed and legacy schema branches are separate and owner field is supported',()=>{
 const schema=JSON.parse(fs.readFileSync(new URL('../schemas/repairSessions.schema.json',import.meta.url),'utf8'));
 assert.equal(schema.items.oneOf.length,2);assert.equal(schema.$defs.typedSession.properties.resolved.const,false);
 for(const key of Object.keys(projectTypedRepair(state)))assert.ok(Object.hasOwn(schema.$defs.typedSession.properties,key));
 assert.ok(schema.$defs.session.properties.userId);
});
