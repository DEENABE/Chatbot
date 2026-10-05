import {containsSecret,unsafeInstruction,fields,safeText,text,memoryError} from './validation.js';
export const DECISIONS=Object.freeze(['SAVE','DO_NOT_SAVE','ASK_USER','UPDATE_EXISTING','DELETE']);
export function evaluateMemory(candidate,existing,{explicit=false,origin='user',deleting=false}={}) {
 if(origin!=='user'||containsSecret(candidate)||unsafeInstruction(JSON.stringify(candidate)))return 'DO_NOT_SAVE';
 if(deleting)return explicit?'DELETE':'ASK_USER';
 if(!explicit)return /\b(today|right now|this morning|temporarily)\b/i.test(candidate.value||'')?'DO_NOT_SAVE':'ASK_USER';
 return existing?'UPDATE_EXISTING':'SAVE';
}
export function validateLongTerm(candidate) {
 fields(candidate,['key','value','category']);
 const key=text(candidate.key,100).toLowerCase();if(!/^[a-z][a-z0-9_.-]*$/.test(key))throw memoryError('Invalid memory key.');
 const value=safeText(candidate.value,2000),category=candidate.category??'fact';
 if(!['preference','fact','project','workflow'].includes(category))throw memoryError('Invalid memory category.');
 return {key,value,category};
}
