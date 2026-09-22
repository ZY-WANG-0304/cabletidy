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

export function commandEnvironment(searchPath) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  return { ...env, PATH: searchPath };
}
