import { BaseAgent } from './BaseAgent.js';

export class NetworkAgent extends BaseAgent {
  constructor() {
    super({
      domain: 'network',
      title: 'Network Agent',
      expertise:
        'You specialize in Wi-Fi and Ethernet adapters, IP configuration, DNS, DHCP, gateways, and connectivity. You always try the least-disruptive fix first (flush DNS, renew IP) before resetting adapters or the TCP/IP stack.'
    });
  }
}

export default NetworkAgent;
