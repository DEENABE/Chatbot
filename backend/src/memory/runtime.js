import {AsyncLocalStorage} from 'node:async_hooks';
import {db} from '../services/db.js';
import {MemoryManager} from './MemoryManager.js';
export const memoryScope=new AsyncLocalStorage();
export const memoryManager=new MemoryManager(db);
/** Best-effort projection cannot authorize work, invalidate checkpoints or leak raw errors. */
export function projectCheckpoint(state) {
 try {
  if(!state.ownerId||!db.prepare('SELECT 1 FROM users WHERE id=?').get(state.ownerId))return;
  memoryManager.task.updateTaskMemory(state.ownerId,state,memoryScope.getStore()||{});
 }
 catch {console.warn('[memory] TASK_PROJECTION_FAILED');}
}
export function memoryRequest(request,response,next) {
 try {
  const conversationId=request.body?.conversationId;
  if(conversationId!==undefined){
   if(typeof conversationId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(conversationId))throw Object.assign(new Error('Invalid conversationId.'),{status:400});
   const existing=db.prepare('SELECT userId FROM chats WHERE id=?').get(conversationId);
   if(!existing){const now=new Date().toISOString();db.prepare('INSERT INTO chats(id,userId,title,createdAt,updatedAt) VALUES(?,?,?,?,?)').run(conversationId,request.userId,'Agent conversation',now,now);}
   memoryManager.repository.conversation(request.userId,conversationId);
  }
  memoryScope.run({userId:request.userId,requestId:request.id,conversationId},next);
 } catch(error){next(error);}
}
