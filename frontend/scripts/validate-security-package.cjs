const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function validateSecurityPackage(output,frontend=path.resolve(__dirname,'..')) {
  const app=path.join(output,'resources','app'),backend=path.join(output,'resources','backend');
  if(fs.existsSync(path.join(backend,'storage')))throw new Error('Release contains user storage');
  const files=['tools/apps/AppQueryNormalizer.js','tools/apps/AppSearchIndex.js','tools/apps/AppFuzzyMatcher.js','tools/apps/AppResolverService.js','tools/DesktopRuntime.js','tools/DesktopCapabilityDiagnostics.js','tools/ToolEngineRouter.js','tools/apps/SystemSettingsCatalog.js','tools/services/SystemSettingsService.js','tools/services/SettingsWorker.js','tools/services/WingetService.js','tools/ExecutionLedger.js','tools/ConfirmationGate.js','tools/DurableConfirmationStore.js',
    'tools/security/ToolRegistry.js','tools/security/ToolRequestValidator.js','tools/security/PathPolicy.js','tools/security/ToolPermissionPolicy.js','tools/security/ToolExecutionGuard.js','tools/security/SecurityAudit.js','tools/security/ReadOnlyMcpServer.js',
    'tools/services/AppService.js','tools/services/FileService.js','tools/services/ProcessService.js','electron/services/ToolActor.js','electron/ipc/tool.ipc.js','electron/ipc/toolBridgeServer.js'];
  for(const name of ['GenericUI.ps1','DesktopUI.ps1','DiscoverApps.ps1','ActivateApp.ps1','InteractWithApp.ps1','OpenTargetUI.ps1','ObserveApp.ps1','SystemSettings.ps1','DesktopAccessibility.cs']){const installed=path.join(output,'resources','desktop-control',name);if(!fs.existsSync(installed)||!fs.readFileSync(installed).equals(fs.readFileSync(path.join(frontend,'tools','apps',name))))throw new Error('Missing or stale desktop resource: '+name);}
  const backendFiles=['src/orchestrator/AgentExecutor.js','src/orchestrator/ToolEngineBridge.js','src/orchestrator/ObservationHandler.js','src/memory/TaskMemoryService.js'];
  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for(const file of files)if(digest(path.join(app,file))!==digest(path.join(frontend,file)))throw new Error('Packaged security file differs: '+file);
  for(const file of backendFiles)if(digest(path.join(backend,file))!==digest(path.join(frontend,'..','backend',file)))throw new Error('Packaged backend file differs: '+file);
  return {securityFiles:files.length+backendFiles.length,sourceIntegrity:'passed',userStorage:'absent'};
}
module.exports={validateSecurityPackage};
if(require.main===module)console.log(JSON.stringify(validateSecurityPackage(path.resolve(process.argv[2]))));
