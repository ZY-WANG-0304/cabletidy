import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireInstanceLock } from "../src/instance-lock.mjs";
import { getPaths } from "../src/config.mjs";
import { processStartTime } from "../src/process-identity.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-lock-race-"));
  const paths = getPaths(directory);
  const releases = [];
  t.after(async () => {
    t.mock.reset();
    for (const release of releases) await release();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const marker = path.join(paths.lock, `owner-${randomUUID()}.json`);
  const current = await processStartTime(process.pid);
  assert.ok(current);
  const previous = current.replace(/\d$/, digit => String((Number(digit) + 1) % 10));
  assert.notEqual(previous, current);
  await fs.mkdir(paths.lock);
  await fs.writeFile(marker, JSON.stringify({ pid: process.pid, startTime: previous, hostname: os.hostname() }));
  const stale = new Date(Date.now() - 60000);
  await fs.utimes(paths.lock, stale, stale);
  return {
    paths, marker,
    async acquire() {
      const lock = await acquireInstanceLock(paths);
      releases.push(lock.release);
      return lock;
    },
  };
}

for (const method of ["readFile", "unlink", "rmdir"]) {
  test(`stale lock reclaim recovers from a transient Windows ${method} sharing violation`, async t => {
    const f = await fixture(t);
    const original = fs[method];
    const target = method === "rmdir" ? f.paths.lock : f.marker;
    let denied = false;
    t.mock.method(fs, method, async (file, ...args) => {
      if (file === target && !denied) {
        denied = true;
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      }
      return original(file, ...args);
    });
    const lock = await f.acquire();
    assert.ok(denied, "the stale generation must exercise the injected sharing violation");
    const entries = await fs.readdir(f.paths.lock);
    assert.equal(entries.length, 1);
    assert.notEqual(path.join(f.paths.lock, entries[0]), f.marker);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.paths.lock, entries[0]), "utf8")), lock.identity);
    await assert.rejects(f.acquire(), { code: "ELOCKED" });
  });
}

test("a retrying stale-lock remover preserves a newly published owner", async t => {
  const f = await fixture(t);
  const rmdir = fs.rmdir;
  let winner;
  let winnerMarker;
  t.mock.method(fs, "rmdir", async (directory, ...args) => {
    if (directory === f.paths.lock && !winner) {
      await rmdir(directory, ...args);
      winner = await f.acquire();
      [winnerMarker] = await fs.readdir(f.paths.lock);
      throw Object.assign(new Error("directory replaced during removal"), { code: "EPERM" });
    }
    return rmdir(directory, ...args);
  });
  await assert.rejects(f.acquire(), { code: "ELOCKED" });
  assert.deepEqual(await fs.readdir(f.paths.lock), [winnerMarker]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.paths.lock, winnerMarker), "utf8")), winner.identity);
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`persistent ${code} during stale-lock removal is reported without discarding the owner`, async t => {
    const f = await fixture(t);
    const before = await fs.readFile(f.marker, "utf8");
    const unlink = fs.unlink;
    const denied = Object.assign(new Error("persistent sharing denial"), { code });
    t.mock.method(fs, "unlink", async (file, ...args) => {
      if (file === f.marker) throw denied;
      return unlink(file, ...args);
    });
    await assert.rejects(f.acquire(), error => error === denied);
    assert.equal(await fs.readFile(f.marker, "utf8"), before);
    assert.deepEqual(await fs.readdir(f.paths.home), ["daemon.lock"]);
  });
}
