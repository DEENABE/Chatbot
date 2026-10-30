import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "../ExecutionContext.js";
import { LIMITS } from "./contract.js";
import { RUNNER_SHA256 } from "./runnerDigest.js";
const runnerPath = fileURLToPath(
  new URL("./PrintSpoolerRunner.ps1", import.meta.url),
);
const error = (code, message = code) =>
  Object.assign(new Error(message), { code });
export function validateRunnerBytes(
  file = runnerPath,
  expected = RUNNER_SHA256,
) {
  if (
    createHash("sha256").update(fs.readFileSync(file)).digest("hex") !==
    expected
  )
    throw error("RUNNER_INTEGRITY_FAILED");
}
// Fixed read-only OS probe. No model input, interpolation, profile or policy bypass.
const ACL_PROBE = `$ErrorActionPreference='Stop'; $p=$env:CHANAKYA_PROTECTED_RUNNER; $root=[Environment]::GetFolderPath('ProgramFiles'); if(!$p.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase)){exit 2}; while($p){$i=Get-Item -LiteralPath $p -Force; if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){exit 3}; $acl=Get-Acl -LiteralPath $p; $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'); if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){exit 5}; foreach($a in $acl.Access){$sid=$a.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($a.AccessControlType -eq 'Allow' -and $sid -notin $trusted -and -not ($a.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ([int]$a.FileSystemRights -band 852310)){exit 4}}; if($p -eq $root){break}; $p=Split-Path -LiteralPath $p}; Write-Output 'protected'`;
function collect(executable, args, { signal, timeout, stdin = "", env } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let bytes = 0,
      stdout = "",
      stderr = "",
      finished = false,
      forcedError;
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      signal,
    });
    const finish = (err, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      err ? reject(err) : resolve(value);
    };
    const abort = () => {
      forcedError = error(
        "EXECUTION_UNCERTAIN",
        "Owned helper cancelled; service effects may remain.",
      );
      child.kill();
    };
    const timer = setTimeout(() => {
      forcedError = error(
        "EXECUTION_UNCERTAIN",
        "Owned helper deadline exceeded.",
      );
      child.kill();
    }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    for (const [stream, key] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ])
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > LIMITS.outputBytes) {
          forcedError = error("OUTPUT_LIMIT");
          child.kill();
          return;
        }
        if (key === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
      });
    child.on("error", (e) => {
      if (child.pid) forcedError = e;
      else finish(e);
    });
    child.on("close", (code) =>
      finish(
        forcedError ||
          (code === 0
            ? null
            : error(
                "HELPER_FAILED",
                stderr.slice(0, 1000) || `Helper exit ${code}`,
              )),
        stdout.trim(),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
/** Runtime is fail-closed in development and user-writable installations. */
export function createProtectedRunner({ packaged = false } = {}) {
  return async (operation, { signal, expected } = {}) => {
    if (process.platform !== "win32" || !packaged)
      throw error("PROTECTED_INSTALL_REQUIRED");
    if (!["inspect", "start", "verify"].includes(operation))
      throw error("INVALID_OPERATION");
    validateRunnerBytes();
    const windows = process.env.SystemRoot;
    if (!windows || !path.isAbsolute(windows))
      throw error("UNSUPPORTED_RUNTIME");
    const executable = path.join(
      windows,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const secure = await collect(
      executable,
      ["-NoProfile", "-NonInteractive", "-Command", ACL_PROBE],
      {
        signal,
        timeout: 5000,
        env: { ...process.env, CHANAKYA_PROTECTED_RUNNER: runnerPath },
      },
    );
    if (secure !== "protected") throw error("PROTECTED_INSTALL_REQUIRED");
    validateRunnerBytes();
    const output = await collect(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        runnerPath,
        "-Operation",
        operation,
      ],
      {
        signal,
        timeout:
          operation === "start"
            ? LIMITS.startMs
            : operation === "verify"
              ? LIMITS.verifyMs
              : LIMITS.diagnosisMs,
        stdin: expected ? JSON.stringify(expected) : "",
      },
    );
    try {
      const result = JSON.parse(output);
      if (operation === "inspect") result.runnerDigest = RUNNER_SHA256;
      return result;
    } catch {
      throw error("INVALID_RUNNER_OUTPUT");
    }
  };
}
