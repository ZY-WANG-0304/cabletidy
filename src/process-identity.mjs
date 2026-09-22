import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const powershell = path.win32.join(
  process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);

export async function processStartTime(pid, {
  platform = process.platform, readFile = fs.readFile, run = execute,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") {
      const [stat, boot] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (!/^\d+$/.test(fields[19]) || !/^[\da-f-]{36}$/i.test(boot.trim())) return null;
      return `linux:${boot.trim()}:${fields[19]}`;
    }
    const options = { timeout: 5000, maxBuffer: 4096, windowsHide: true };
    if (platform === "darwin") {
      const { stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        ...options, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      const value = stdout.trim().replace(/\s+/g, " ");
      return /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value)
        ? `darwin:${value}` : null;
    }
    if (platform === "win32") {
      const { stdout } = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`,
      ], options);
      return /^\d{17,}$/.test(stdout.trim()) ? `win32:${stdout.trim()}` : null;
    }
  } catch {
    // Query failures do not prove that a PID is dead or still has its old owner.
  }
  return null;
}

export async function inspectProcess(identity, {
  kill = process.kill, readStartTime = processStartTime, hostname = os.hostname(),
} = {}) {
  const pid = identity?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || (identity.hostname && identity.hostname !== hostname)) {
    return "unknown";
  }
  try {
    kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return "dead";
    if (error.code !== "EPERM") return "unknown";
  }
  if (!identity.startTime) return "unknown";
  const current = await readStartTime(pid);
  if (!current) return "unknown";
  if (/^(linux|darwin|win32):/.test(identity.startTime)) {
    if (identity.startTime.split(":")[0] !== current.split(":")[0]) return "unknown";
    return current === identity.startTime ? "alive" : "dead";
  }
  // Old Linux ticks can disprove ownership, but without a boot ID cannot prove it.
  if (/^\d+$/.test(identity.startTime) && current.startsWith("linux:") && current.split(":").at(-1) !== identity.startTime) {
    return "dead";
  }
  return "unknown";
}
