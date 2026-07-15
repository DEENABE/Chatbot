import { spawn } from 'child_process';
import { getWakewordScriptPath } from '../utils/pathHelper.js';
import { logger } from '../utils/logger.js';

let wakewordProcess = null;

export function startWakeWordDetector(sendCallback) {
  const scriptPath = getWakewordScriptPath();
  logger.log(`Starting Wake Word detector with script: ${scriptPath}`);

  wakewordProcess = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  wakewordProcess.stdout?.on("data", (data) => {
    const output = data.toString().trim();
    if (!output) return;
    const lines = output.split("\n");
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.event === "wakeword") {
          logger.log("Wake word detected:", parsed.text);
          sendCallback(parsed);
        } else if (parsed.event === "error") {
          logger.error("Wake word process error:", parsed.message);
        }
      } catch (e) {
        // incomplete JSON or standard output
      }
    }
  });

  wakewordProcess.stderr?.on("data", (data) => {
    logger.error(`[wakeword stderr] ${data.toString().trim()}`);
  });

  wakewordProcess.on("exit", (code) => {
    logger.log(`Wake word process exited with code ${code}`);
  });

  return wakewordProcess;
}

export function killWakeWordDetector() {
  if (wakewordProcess && !wakewordProcess.killed) {
    logger.log('Terminating wake word process...');
    wakewordProcess.kill();
    wakewordProcess = null;
  }
}
