import { BaseAgent } from './BaseAgent.js';

export class SecurityAgent extends BaseAgent {
  constructor() {
    super({
      domain: 'security',
      title: 'Security Agent',
      expertise:
        'You specialize in Windows Defender, firewall, malware detection, and threat remediation. You only ever ENABLE or strengthen protection and run scans — you never disable security as a fix.'
    });
  }
}

export default SecurityAgent;
