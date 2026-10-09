const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function validateSecurityPackage(output, frontend = path.resolve(__dirname, '..')) {
  const app = path.join(output, 'resources', 'app'),
    backend = path.join(output, 'resources', 'backend');
  require('./validate-app-portability.cjs').validateApplicationPortability(
    path.join(output, 'resources'),
  );
  if (fs.existsSync(path.join(backend, 'storage')))
    throw new Error('Release contains user storage');
  const files = [
    'tools/apps/AppQueryNormalizer.js',
    'tools/apps/AppSearchIndex.js',
    'tools/apps/AppFuzzyMatcher.js',
    'tools/apps/AppResolverService.js',
    'tools/DesktopRuntime.js',
    'tools/DesktopCapabilityDiagnostics.js',
    'tools/ToolEngineRouter.js',
    'tools/apps/SystemSettingsCatalog.js',
    'tools/services/SystemSettingsService.js',
    'tools/services/SettingsWorker.js',
    'tools/services/SettingsElevator.js',
    'tools/apps/SystemSettingsAdminDigest.js',
    'tools/services/WingetService.js',
    'tools/services/WebInstallService.js',
    'tools/ExecutionLedger.js',
    'tools/ConfirmationGate.js',
    'tools/DurableConfirmationStore.js',
    'tools/security/ToolRegistry.js',
    'tools/security/ToolRequestValidator.js',
    'tools/security/PathPolicy.js',
    'tools/security/ToolPermissionPolicy.js',
    'tools/security/ToolExecutionGuard.js',
    'tools/security/SecurityAudit.js',
    'tools/security/ReadOnlyMcpServer.js',
    'tools/services/AppService.js',
    'tools/services/FileService.js',
    'tools/services/ProcessService.js',
    'electron/services/ToolActor.js',
    'electron/ipc/tool.ipc.js',
    'electron/ipc/toolBridgeServer.js',
  ];
  for (const name of [
    'GenericUI.ps1',
    'DesktopUI.ps1',
    'DiscoverApps.ps1',
    'ActivateApp.ps1',
    'InteractWithApp.ps1',
    'OpenTargetUI.ps1',
    'ObserveApp.ps1',
    'SystemSettings.ps1',
    'SystemSettingsAdmin.ps1',
    'DesktopAccessibility.cs',
  ]) {
    const installed = path.join(output, 'resources', 'desktop-control', name);
    if (
      !fs.existsSync(installed) ||
      !fs
        .readFileSync(installed)
        .equals(fs.readFileSync(path.join(frontend, 'tools', 'apps', name)))
    )
      throw new Error('Missing or stale desktop resource: ' + name);
  }
  const backendFiles = [
    'src/config.js',
    'src/app.js',
    'src/server.js',
    'src/db/documentMigrations.js',
    'src/services/documentsStore.js',
    'src/services/documentService.js',
    'src/services/documentIngestionService.js',
    'src/services/historyService.js',
    'src/services/workspaceService.js',
    'src/services/workspacePaths.js',
    'src/services/modelRouter.js',
    'src/services/modelRouteAuthority.js',
    'src/services/modelRuntime.js',
    'src/services/inferenceGate.js',
    'src/services/imageAttachmentService.js',
    'src/services/ollamaService.js',
    'src/routes/upload.js',
    'src/routes/workspaces.js',
    'src/routes/models.js',
    'src/docqa/ingest.js',
    'src/docqa/retrieve.js',
    'src/docqa/structuredStore.js',
    'src/orchestrator/AgentExecutor.js',
    'src/orchestrator/AgentOrchestrator.js',
    'src/orchestrator/ToolEngineBridge.js',
    'src/orchestrator/ObservationHandler.js',
    'src/memory/TaskMemoryService.js',
  ];
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  files.push(
    'electron/main.js',
    'electron/preload.cjs',
    'electron/managers/BackendManager.js',
    'electron/managers/WindowManager.js',
    'electron/services/BackendHealth.js',
    'electron/utils/runtimeEndpoint.js',
    'electron/utils/runtimeStorage.js',
    'electron/utils/redactDiagnostics.js',
    'electron/ipc/workspace.ipc.js',
    'tools/security/ModelRouteAuthority.js',
    'tools/apps/AppDiscoveryService.js',
    'tools/apps/AppRegistryService.js',
    'tools/apps/AppMachineIdentity.js',
    'tools/services/GenericDesktopService.js',
  );
  files.push(
    'tools/BaseToolService.js',
    'tools/apps/PrimitiveTools.js',
    'tools/apps/SemanticUI.js',
    'tools/apps/LocalVisionAdapter.js',
    'tools/apps/InputPolicy.js',
    'tools/services/UIAutomationService.js',
    'tools/repair/contract.js',
  );
  backendFiles.push(
    'src/orchestrator/SoftwareTask.js',
    'src/orchestrator/SoftwareRunner.js',
    'src/orchestrator/TaskRouter.js',
    'src/orchestrator/OrchestratorPlanner.js',
    'src/orchestrator/Verifier.js',
    'src/ai/desktopChat.js',
    'src/ai/llmClient.js',
    'src/orchestrator/DesktopPrimitiveTools.js',
    'src/orchestrator/GenericAppPlanner.js',
    'src/orchestrator/GenericDesktopTask.js',
    'src/orchestrator/OrchestratorPlanner.js',
    'src/orchestrator/CapabilityContracts.js',
    'src/orchestrator/WindowsRepairContract.js',
  );
  files.push(
    'tools/services/SoftwareService.js',
    'tools/software/contracts.js',
    'tools/software/ProviderRegistry.js',
    'tools/software/SoftwareResolver.js',
    'tools/software/SoftwarePlanStore.js',
    'tools/software/TrustPolicy.js',
    'tools/software/InstallerMetadata.js',
    'tools/software/InstallerExecutor.js',
    'tools/software/InstalledSoftwareInventory.js',
    'tools/software/providers/discoverDefaultProviders.js',
    'tools/software/providers/discoverProviders.js',
    'tools/software/providers/MetadataProvider.js',
    'tools/software/providers/OfflineProvider.js',
    'tools/software/providers/WingetProvider.js',
    'electron/services/SoftwareKey.js',
  );
  // Astra multi-step tasks: Save As driver and the plan runner must ship exactly as reviewed.
  files.push(
    'tools/apps/SaveAsDialog.js',
    'tools/apps/Phase2ApplicationPolicy.js',
    'tools/apps/SettingsCatalog.js',
  );
  backendFiles.push(
    'src/orchestrator/AstraTask.js',
    'src/orchestrator/AstraRunner.js',
    'src/orchestrator/ComputerTaskPolicy.js',
    'src/routes/chat.js',
  );
  // The elevated settings helper must match the digest pinned in the app (BOM and line endings do not count).
  {
    const pinned = /ADMIN_SCRIPT_SHA256\s*=\s*["'`]([0-9a-f]{64})["'`]/.exec(
      fs.readFileSync(path.join(app, 'tools', 'apps', 'SystemSettingsAdminDigest.js'), 'utf8'),
    )?.[1];
    const packagedScript = fs
      .readFileSync(
        path.join(output, 'resources', 'desktop-control', 'SystemSettingsAdmin.ps1'),
        'utf8',
      )
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n');
    if (
      !pinned ||
      crypto.createHash('sha256').update(packagedScript, 'utf8').digest('hex') !== pinned
    )
      throw new Error('Packaged administrator settings helper integrity mismatch');
  }
  for (const file of files)
    if (digest(path.join(app, file)) !== digest(path.join(frontend, file)))
      throw new Error('Packaged security file differs: ' + file);
  for (const file of backendFiles)
    if (digest(path.join(backend, file)) !== digest(path.join(frontend, '..', 'backend', file)))
      throw new Error('Packaged backend file differs: ' + file);
  return {
    securityFiles: files.length + backendFiles.length,
    sourceIntegrity: 'passed',
    userStorage: 'absent',
  };
}
module.exports = { validateSecurityPackage };
if (require.main === module)
  console.log(JSON.stringify(validateSecurityPackage(path.resolve(process.argv[2]))));
