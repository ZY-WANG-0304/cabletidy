import fs from "node:fs/promises";
import path from "node:path";

export async function writeCodexCommand(directory, source) {
  if (process.platform === "win32") {
    await fs.writeFile(path.join(directory, "codex.cjs"), source);
    await fs.writeFile(path.join(directory, "codex.cmd"), `@"${process.execPath}" "%~dp0codex.cjs" %*\r\n`);
  } else {
    await fs.writeFile(path.join(directory, "codex"), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  }
}

export function fixtureEnvironment(overrides = {}) {
  // Local fixtures must not inherit a developer's upstream proxy settings.
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)));
  // Remove unset overrides before Node deduplicates Windows environment keys.
  return Object.fromEntries(Object.entries({ ...inherited, ...overrides })
    .filter(([, value]) => value !== undefined));
}

export function commandEnvironment(searchPath, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => key.toLowerCase() !== "path"));
  return { ...env, PATH: searchPath };
}
