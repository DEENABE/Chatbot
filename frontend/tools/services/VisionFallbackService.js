// Optional local-only adapter. There is no model-supplied coordinate executor.
export class VisionFallbackService {
 constructor({captureWindow,analyseLocal}={}){this.captureWindow=captureWindow;this.analyseLocal=analyseLocal;}
 async inspect({windowId,bounds,sensitiveRegions,privacyVerified}) {
  if(!this.captureWindow||!this.analyseLocal)return {success:false,errorCode:'VISION_UNAVAILABLE',retryable:false};
  if(!windowId||!bounds||privacyVerified!==true||!Array.isArray(sensitiveRegions))return {success:false,errorCode:'VISION_PRIVACY_UNVERIFIED',retryable:false};
  const frame=await this.captureWindow({windowId,bounds,redact:sensitiveRegions,persist:false});
  try {const controls=await this.analyseLocal(frame);return {success:true,controls:controls.filter(c=>c.confidence>=0.95&&c.x>=0&&c.y>=0&&c.x+c.width<=bounds.width&&c.y+c.height<=bounds.height),requiresAccessibilityValidation:true};}
  finally{if(Buffer.isBuffer(frame))frame.fill(0);}
 }
}
