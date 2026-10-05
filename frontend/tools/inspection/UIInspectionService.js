import {WindowsUIAProvider} from './WindowsUIAProvider.js';
/**
 * @typedef {Object} UIInspectionProvider
 * @property {(target: {applicationName:string,processId:number,windowHandle:string,executablePath:string}, options: Object) => Promise<Object>} inspect
 * @property {() => Promise<void>} [close]
 *
 * Stage 1 returns an INTERNAL raw tree. Never send it to a model or register it
 * as an agent tool. Stage 2 will add normalization and READ bridge integration.
 */
export class UIInspectionService{
 constructor({provider=new WindowsUIAProvider()}={}){if(typeof provider?.inspect!=='function')throw new TypeError('An inspection provider is required.');this.provider=provider;}
 async inspect(target,options={}){return this.provider.inspect(target,options);}
 async close(){await this.provider.close?.();}
}
