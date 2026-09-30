import test from 'node:test';
import assert from 'node:assert/strict';
import { AppDiscoveryService } from '../apps/AppDiscoveryService.js';
import { AppResolverService } from '../apps/AppResolverService.js';
import { ToolEngineRouter } from '../ToolEngineRouter.js';
import { AppRegistryService } from '../apps/AppRegistryService.js';
import { executionContext } from '../ExecutionContext.js';
const enabled=process.platform==='win32'&&process.env.CHANAKYA_APP_INTEGRATION==='1';
test('Windows discovery, permission routing, Calculator activation and installed VLC launch', {skip:!enabled,timeout:60000},async()=>{
  const result=await new AppDiscoveryService().discover();assert.deepEqual(result.errors,[]);assert.ok(result.apps.length>0);
  const resolver=new AppResolverService();const calc=resolver.resolve('Calculator',result.apps);assert.equal(calc.status,'APP_RESOLVED');
  for(const query of ['VS Code','Chrome','VLC']) {const match=resolver.resolve(query,result.apps);if(match.success)assert.ok(match.app.executablePath||match.app.appUserModelId);}
  const registry=new AppRegistryService({discovery:{discover:async()=>result}});
  const router=new ToolEngineRouter({appOptions:{registry}});
  try {
    for(const query of ['Calculator','VLC']) {
      if(!resolver.resolve(query,result.apps).success)continue;
      const launched=await executionContext.run({authenticated:true,scope:'backend:app-test',taskId:'integration',origin:'model'},()=>router.dispatch({tool:'app',action:'openApp',params:{query}}));
      assert.equal(launched.success,true,JSON.stringify(launched));assert.equal(launched.data.status,'APP_OPENED');assert.equal(launched.permission.decision,'ALLOW');assert.ok(launched.data.processId>0);
    }
  } finally {registry.close();}
  assert.equal(resolver.resolve('ChanakyaMissingApp987123',result.apps).status,'APP_NOT_FOUND');
});
test('Windows Settings pages, a Control Panel applet and Device Manager open with verified evidence', {skip:!enabled,timeout:180000},async()=>{
  const result=await new AppDiscoveryService().discover();
  const registry=new AppRegistryService({discovery:{discover:async()=>result}});
  const router=new ToolEngineRouter({appOptions:{registry}});
  const resolver=new AppResolverService();
  const applet=result.apps.find(a=>a.source==='control_panel'&&a.launchArgs[1]==='Microsoft.ProgramsAndFeatures');
  try {
    for(const query of ['wifi settings','display settings','windows update','device manager',...(applet?[applet.name]:[])]) {
      assert.equal(resolver.resolve(query,result.apps).success,true,query);
      const launched=await executionContext.run({authenticated:true,scope:'backend:system-settings-test',taskId:'integration',origin:'model'},()=>router.dispatch({tool:'app',action:'openApp',params:{query}}));
      assert.equal(launched.success,true,`${query}: ${JSON.stringify(launched)}`);assert.equal(launched.data.status,'APP_OPENED',query);
      assert.equal(launched.data.verification?.status,'verified',`${query}: ${JSON.stringify(launched.data.verification)}`);
    }
  } finally {registry.close();}
});
