import test from 'node:test';
import assert from 'node:assert/strict';
import {AppResolverService,aliasesFor} from '../apps/AppResolverService.js';
import {safeBrowserUrl,publicBrowserUrl} from '../browser/BrowserPolicy.js';
import {computerTask} from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';
import {createOrchestratorPlan} from '../../../backend/src/orchestrator/OrchestratorPlanner.js';
const resolver=new AppResolverService();
const apps=[['Google Chrome','chrome'],['Visual Studio Code','Code'],['VLC media player','vlc'],['Visual Studio','devenv'],['Android Studio','studio'],['Control Panel','control'],['File Explorer','explorer']].map(([name,exe])=>({name,id:name,available:true,source:'start_menu',executablePath:`C:\\Apps\\${exe}.exe`,aliases:aliasesFor({name,executablePath:`C:\\Apps\\${exe}.exe`})}));
test('acceptance typo corpus resolves only strong unique matches',()=>{
 for(const [q,name] of [['conteol panel','Control Panel'],['contrl panel','Control Panel'],['crome','Google Chrome'],['vscoed','Visual Studio Code'],['vlcc','VLC media player'],['fil explorrer','File Explorer']])assert.equal(resolver.resolve(q,apps).app?.name,name,q);
 for(const q of ['studio'])assert.equal(resolver.resolve(q,apps).status,'AMBIGUOUS_APP');
 assert.equal(resolver.resolve('zyxyzq',apps).status,'APP_NOT_FOUND');
 assert.equal(resolver.resolve('calc.exe && dangerous-command',apps).status,'APP_NOT_FOUND');
 assert.equal(resolver.resolve('Duplicate',[{name:'Duplicate',id:'1',available:true},{name:'Duplicate',id:'2',available:true}]).status,'AMBIGUOUS_APP');
});
test('browser and compound goals retain specialized execution before generic UI',async()=>{
 for(const [text,tool,action] of [['open crome and search OpenAI','browser','search'],['open chrome and go to github','browser','navigate'],['open calculator and add five and four','uiAutomation','calculate'],['open settings and show bluetooth','app','openApp']]){
 const task=computerTask(text);assert.equal(task.call.tool,tool);const plan=await createOrchestratorPlan({task:text});assert.equal(plan.steps[0].action,action);
 }
 const plan=await createOrchestratorPlan({task:'open vscoed and open my project'});assert.equal(plan.steps.at(-1).action,'open');
});
test('browser rejects executable URLs, credentials and side-effect destinations',()=>{
 for(const url of ['javascript:alert(1)','file:///C:/secret','https://user:pass@example.com','https://example.com/delete?id=1','https://example.com/logout'])assert.throws(()=>safeBrowserUrl(url));
 assert.equal(safeBrowserUrl('example.com'),'https://example.com/');
 assert.equal(publicBrowserUrl('https://example.com/?token=secret#private'),'https://example.com/');
});
