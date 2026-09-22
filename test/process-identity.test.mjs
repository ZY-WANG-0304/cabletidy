import test from "node:test";
import assert from "node:assert/strict";
import { inspectProcess, processStartTime } from "../src/process-identity.mjs";

const boot = "bf23e060-d468-4a6b-97bd-7ff0b95a3aab";
const startTime = `linux:${boot}:123`;

test("the current platform can identify this process without relying on PID alone", async () => {
  const startTime = await processStartTime(process.pid);
  assert.ok(startTime, `process identity is required on ${process.platform}`);
  assert.equal(await inspectProcess({ pid: process.pid, startTime }), "alive");
});

test("Linux identity includes boot ID and parses names containing spaces and parentheses", async () => {
  const fields = ["S", ...Array(18).fill("0"), "123", "456"];
  assert.equal(await processStartTime(1234, {
    platform: "linux",
    readFile: async file => file.endsWith("boot_id") ? `${boot}\n` : `1234 (a ) tricky (name) ${fields.join(" ")}`,
  }), startTime);
});

test("macOS and Windows use OS queries even when /proc is unavailable", async () => {
  for (const [platform, stdout, expected] of [
    ["darwin", " Tue Sep 22  08:01:02 2026\n", "darwin:Tue Sep 22 08:01:02 2026"],
    ["win32", "639256032620000000\r\n", "win32:639256032620000000"],
  ]) {
    const calls = [];
    const result = await processStartTime(42, {
      platform,
      readFile: () => assert.fail("must not access /proc"),
      run: async (...args) => { calls.push(args); return { stdout }; },
    });
    assert.equal(result, expected);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][1].some(arg => arg.includes("42")));
    assert.ok(calls[0][2].timeout > 0);
  }
});

test("process query failures and invalid output remain unknown", async () => {
  for (const platform of ["linux", "darwin", "win32", "unsupported"]) {
    assert.equal(await processStartTime(42, {
      platform, readFile: async () => { throw new Error("unavailable"); },
      run: async () => { throw new Error("unavailable"); },
    }), null);
    assert.equal(await processStartTime(42, {
      platform, readFile: async () => "bad", run: async () => ({ stdout: "bad" }),
    }), null);
  }
});

test("identity distinguishes reused PIDs, reboot, death, permissions and legacy records", async () => {
  const live = { kill: () => {}, readStartTime: async () => startTime, hostname: "host" };
  assert.equal(await inspectProcess({ pid: 42, startTime }, live), "alive");
  assert.equal(await inspectProcess({ pid: 42, startTime: `linux:${boot}:456` }, live), "dead");
  assert.equal(await inspectProcess({ pid: 42, startTime: `linux:${"0".repeat(36)}:123` }, live), "dead");
  assert.equal(await inspectProcess({ pid: 42 }, live), "unknown");
  assert.equal(await inspectProcess({ pid: 42, startTime: "123" }, live), "unknown");
  assert.equal(await inspectProcess({ pid: 42, startTime: "456" }, live), "dead");
  assert.equal(await inspectProcess({ pid: 42, startTime }, { ...live, readStartTime: async () => null }), "unknown");
  for (const [code, expected] of [["ESRCH", "dead"], ["EPERM", "alive"], ["EINVAL", "unknown"]]) {
    assert.equal(await inspectProcess({ pid: 42, startTime }, {
      ...live, kill: () => { throw Object.assign(new Error(code), { code }); },
    }), expected);
  }
  assert.equal(await inspectProcess({ pid: 42, hostname: "another-host", startTime }, live), "unknown");
  for (const pid of [null, -1, 0, "42", 1.5]) {
    assert.equal(await inspectProcess({ pid }, { kill: () => assert.fail("invalid PID") }), "unknown");
  }
});
