import { BaseAgent } from './BaseAgent.js';

export class PerformanceAgent extends BaseAgent {
  constructor() {
    super({
      domain: 'performance',
      title: 'Performance Agent',
      expertise:
        'You specialize in slowness, freezing, high CPU/RAM/disk usage, low disk space, and startup bloat. You identify the exact offending process or resource before recommending action, and you never kill critical system processes.'
    });
  }
}

export default PerformanceAgent;
