import { BaseAgent } from './BaseAgent.js';

export class BluetoothAgent extends BaseAgent {
  constructor() {
    super({
      domain: 'bluetooth',
      title: 'Bluetooth Agent',
      expertise:
        'You specialize in Bluetooth radios, the Bluetooth Support Service (bthserv), pairing, and wireless audio devices. You know the difference between a disabled adapter and a software radio that is simply switched off.'
    });
  }
}

export default BluetoothAgent;
