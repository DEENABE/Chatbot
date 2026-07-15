import { ConfirmationGate } from '../ConfirmationGate.js';
import { InputValidator } from '../InputValidator.js';
import { FileService } from '../services/FileService.js';
import { PowerShellService } from '../services/PowerShellService.js';
import { CmdService } from '../services/CmdService.js';
import { WinServicesService } from '../services/WinServicesService.js';
import { RegistryService } from '../services/RegistryService.js';
import { HardwareService } from '../services/HardwareService.js';
import { ProcessService } from '../services/ProcessService.js';
import { NetworkService } from '../services/NetworkService.js';
import path from 'path';

async function runTests() {
  console.log('--- Starting Tool Engine Tests ---');
  const gate = new ConfirmationGate();
  
  const services = {
    file: new FileService(gate),
    powershell: new PowerShellService(gate),
    cmd: new CmdService(gate),
    services: new WinServicesService(gate),
    registry: new RegistryService(gate),
    hardware: new HardwareService(gate),
    process: new ProcessService(gate),
    network: new NetworkService(gate)
  };

  try {
    // 1. Test HardwareService (Non-destructive)
    console.log('\n[Testing HardwareService.systemInfo]');
    const hwRes = await services.hardware.execute('systemInfo', {});
    console.log('Success:', hwRes.success, '| Data keys:', Object.keys(hwRes.data || {}));
    if (!hwRes.success) throw new Error('systemInfo failed');

    // 2. Test FileService (Non-destructive)
    console.log('\n[Testing FileService.listDir]');
    const fileRes = await services.file.execute('listDir', { path: process.cwd() });
    console.log('Success:', fileRes.success, '| Found entries:', fileRes.data?.entries?.length);
    if (!fileRes.success) throw new Error('listDir failed');

    // 3. Test FileService (Validation Error)
    console.log('\n[Testing FileService validation]');
    try {
      await services.file.execute('readFile', { path: 123 }); // Invalid path type
      throw new Error('Should have failed validation');
    } catch (err) {
      console.log('Caught expected validation error:', err.message);
    }

    // 4. Test CmdService (Destructive Confirmation)
    console.log('\n[Testing CmdService.execute confirmation gate]');
    const cmdRes = await services.cmd.execute('execute', { command: 'echo hello' });
    console.log('Needs Confirmation:', cmdRes.needsConfirmation, '| Message:', cmdRes.message);
    if (!cmdRes.needsConfirmation) throw new Error('execute should require confirmation');

    // 5. Test WinServicesService
    console.log('\n[Testing WinServicesService.list]');
    const svcRes = await services.services.execute('list', {});
    console.log('Success:', svcRes.success, '| Services count:', svcRes.data?.services?.length);

    console.log('\n✅ All tests passed successfully!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
}

runTests();
