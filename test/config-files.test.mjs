import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../src/config.mjs";

for (const persistent of [false, true]) {
  test(`atomic JSON writes ${persistent ? "preserve existing data on persistent denial" : "recover from a transient sharing violation"}`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cabletidy-atomic-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "config.json");
    await writeJsonAtomic(file, { revision: 1 });
    const rename = fs.rename;
    let denied = false;
    t.mock.method(fs, "rename", async (source, destination) => {
      assert.equal(JSON.parse(await fs.readFile(file, "utf8")).revision, 1);
      if (persistent || !denied) {
        denied = true;
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      }
      return rename(source, destination);
    });
    if (persistent) await assert.rejects(writeJsonAtomic(file, { revision: 2 }), { code: "EPERM" });
    else await writeJsonAtomic(file, { revision: 2 });
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).revision, persistent ? 1 : 2);
    assert.deepEqual(await fs.readdir(directory), ["config.json"]);
  });
}
