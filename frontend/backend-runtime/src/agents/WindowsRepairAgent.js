import { BaseAgent } from './BaseAgent.js';

export class WindowsRepairAgent extends BaseAgent {
  constructor() {
    super({
      domain: 'windows',
      title: 'Windows Repair Agent',
      expertise:
        'You are the general-purpose Windows repair specialist for anything not owned by another agent: audio, display, printers, drivers, services, Windows Update, and system-file integrity. You diagnose with the event log and service/device state before changing anything.'
    });
  }
}

export default WindowsRepairAgent;
