import callbackFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { readRuntimeInfo } from "./config.mjs";
import { inspectProcess, processStartTime } from "./process-identity.mjs";

const STALE_MS = 10_000;
const ownerName = /^owner-[\da-f-]{36}\.json$/;

export async function acquireInstanceLock(paths) {
  const identity = { pid: process.pid, startTime: await processStartTime(process.pid), hostname: os.hostname() };
  const marker = `owner-${randomUUID()}.json`;
  const filesystem = {
    ...callbackFs,
    mkdir(directory, callback) {
      publishOwner(directory, marker, identity).then(() => callback(), callback);
    },
    rmdir(directory, callback) {
      removeOwner(directory, marker).then(() => callback(), callback);
    },
    rmdirSync(directory) {
      try {
        callbackFs.unlinkSync(path.join(directory, marker));
        callbackFs.rmdirSync(directory);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      }
    },
  };
  while (true) {
    try {
      const release = await lockfile.lock(paths.home, {
        lockfilePath: paths.lock,
        // Age alone must never evict a paused process. Reclaim is handled below.
        stale: Number.MAX_SAFE_INTEGER,
        update: 2000,
        fs: filesystem,
      });
      return { release, identity };
    } catch (error) {
      if (error.code !== "ELOCKED") throw error;
      const inspection = await inspectLock(paths);
      if (!inspection) continue;
      if (inspection.state === "alive" || !inspection.stale) {
        throw Object.assign(new Error(
          `此数据目录已有 CableTidy 实例运行，或异常退出后的锁尚未过期 (ELOCKED)；异常退出后等待 10 秒再重试: ${paths.home}`,
        ), { code: "ELOCKED" });
      }
      if (inspection.state === "unknown" || !inspection.marker) {
        throw Object.assign(new Error(
          `无法确认旧实例锁的进程身份 (ELOCKUNKNOWN${inspection.pid ? `, PID ${inspection.pid}` : ""})。请先检查并停止使用此数据目录的 CableTidy；确认实例已退出后，手动删除锁目录并重新启动: ${paths.lock}`,
        ), { code: "ELOCKUNKNOWN" });
      }
      await removeOwner(paths.lock, inspection.marker);
    }
  }
}

async function publishOwner(directory, marker, identity) {
  // Publish a populated directory atomically, so reclaimers never see a new
  // owner without its identity and cannot rmdir a newly acquired lock.
  try {
    await fs.lstat(directory);
    throw Object.assign(new Error("Lock exists"), { code: "EEXIST" });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const staged = await fs.mkdtemp(path.join(path.dirname(directory), ".daemon-lock-"));
  try {
    await fs.writeFile(path.join(staged, marker), JSON.stringify(identity), { mode: 0o600, flag: "wx" });
    try {
      await fs.rename(staged, directory);
    } catch (error) {
      // Windows reports EPERM/EACCES for an existing destination directory.
      if (["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(error.code)) {
        await fs.lstat(directory);
        throw Object.assign(error, { code: "EEXIST" });
      }
      throw error;
    }
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

async function removeOwner(directory, marker) {
  try {
    // Only remove the inspected generation. A losing reclaimer cannot remove
    // the new owner's unique marker, and rmdir refuses a populated directory.
    await fs.unlink(path.join(directory, marker));
    await fs.rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

async function inspectLock(paths) {
  try {
    const entries = await fs.readdir(paths.lock);
    const markers = entries.filter(name => ownerName.test(name) || name === "owner.json");
    const marker = entries.length === 1 && markers.length === 1 ? markers[0] : null;
    let identity;
    if (marker) {
      try { identity = JSON.parse(await fs.readFile(path.join(paths.lock, marker), "utf8")); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        if (error.name !== "SyntaxError") throw error;
      }
    } else if (!entries.length) {
      // Legacy empty locks have no generation token, so even a dead runtime
      // PID cannot make their removal safe against concurrent reclaimers.
      try {
        const runtime = await readRuntimeInfo(paths);
        identity = runtime && { pid: runtime.pid, startTime: runtime.pidStartTime };
      } catch { /* Missing or malformed legacy metadata requires manual recovery. */ }
    }
    const state = await inspectProcess(identity);
    // Another reclaimer may have removed its marker while we read the entries.
    // Read freshness last so that transition is not mistaken for an old empty lock.
    const stat = await fs.stat(paths.lock);
    return { marker, pid: identity?.pid, state, stale: Date.now() - stat.mtimeMs >= STALE_MS };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
