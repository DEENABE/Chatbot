import {BaseToolService} from '../BaseToolService.js';
import {executionContext} from '../ExecutionContext.js';
import {createHash} from 'node:crypto';
import {inferCapabilities,resolveSemanticControl} from '../apps/SemanticUIResolver.js';
export class AppInspectorService extends BaseToolService {
 constructor(gate,appService,ui){super('inspector',gate);this.appService=appService;this.ui=ui;this.contexts=new Map();}
 get actions(){const query={query:{type:'string',maxLength:200}};return {
  inspect:{schema:query,handler:p=>this.inspect(p.query),description:'Inspect a discovered app accessibility tree and infer a bounded capability summary.',destructive:false},
  resolveControl:{schema:{...query,goal:{type:'string',required:true,maxLength:200}},handler:async p=>{const observed=await this.inspect(p.query);const result=resolveSemanticControl(p.goal,observed.controls);if(!result.success)throw Object.assign(new Error(result.errorCode),{code:result.errorCode});return result;},description:'Find a high-confidence semantic control without clicking.',destructive:false},
  navigate:{schema:{...query,goal:{type:'string',required:true,maxLength:200}},handler:p=>this.navigate(p),description:'Discover and select an application tab or expand a menu, then inspect the changed UI.',destructive:false},
 } }
 async inspect(query){const scope=executionContext.getStore()?.scope||'local';const previous=this.contexts.get(scope);query||=this.appService.activeContexts?.get(scope)?.query||previous?.query;
  if(!query)throw Object.assign(new Error('Specify an application to inspect.'),{code:'WINDOW_NOT_FOUND'});
  const resolved=await this.appService.resolve(query);if(!resolved.success)throw Object.assign(new Error(resolved.message),{code:resolved.status});
  const raw=await this.ui.generic('listControls',{query});
  const controls=(raw.controls||[]).filter(c=>!c.sensitive&&c.enabled!==false&&!c.offscreen).slice(0,200);
  if(!controls.length)throw Object.assign(new Error('The app exposes no visible safe accessibility controls.'),{code:'UI_TREE_EMPTY',retryable:true});
  const fingerprint=createHash('sha256').update(JSON.stringify(controls)).digest('hex');
  const capabilities=previous?.appId===resolved.app.id&&previous.fingerprint===fingerprint?previous.capabilities:inferCapabilities(controls);
  const state={query,appId:resolved.app.id,processId:raw.processId,windowId:raw.windowId,window:raw.windowTitle,controls,capabilities,fingerprint,lastInspection:new Date().toISOString()};
  this.contexts.set(scope,state);return {success:true,status:'APP_INSPECTED',...state,verification:raw.verification};
 }
 async navigate(p){const before=await this.inspect(p.query);const selected=resolveSemanticControl(p.goal,before.controls);
  if(!selected.success)throw Object.assign(new Error(selected.errorCode),{code:selected.errorCode,retryable:selected.retryable});
  const c=selected.control;
  if(!['TabItem','MenuItem','ControlType.TabItem','ControlType.MenuItem'].includes(c.controlType))throw Object.assign(new Error('Only tabs and expandable menus are navigation controls.'),{code:'PERMISSION_REQUIRED'});
  await this.ui.generic('navigateControl',{query:before.query,automationId:c.automationId||undefined,controlName:c.name,controlType:c.controlType.replace('ControlType.','')});
  const after=await this.inspect(before.query);return {...after,matchConfidence:selected.confidence,strategy:'UI_AUTOMATION',changed:after.fingerprint!==before.fingerprint};
 }
}
