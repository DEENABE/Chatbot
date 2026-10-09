/** A PID file does not prove process ownership. Port conflicts never justify killing it. */
import fs from 'node:fs';
export function reclaimStalePort() {
  /* Retained compatibility: deliberately no process action. */
}
export function recordOwnPid(pidFilePath) {
  try {
    fs.writeFileSync(pidFilePath, String(process.pid));
  } catch {
    /* optional diagnostics */
  }
}
export function clearOwnPid(pidFilePath) {
  try {
    if (fs.readFileSync(pidFilePath, 'utf8').trim() === String(process.pid))
      fs.unlinkSync(pidFilePath);
  } catch {
    /* missing or different owner */
  }
}
