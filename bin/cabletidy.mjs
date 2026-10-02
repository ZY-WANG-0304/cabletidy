#!/usr/bin/env node
import { existsSync } from "node:fs";
import { launch, root, startBackground } from "./native.mjs";

try {
  const args = process.argv.slice(2);
  const command = args[0] || "status";
  if (["start", "stop"].includes(command) && args.length > 1 && !(command === "start" && args.length === 2 && args[1] === "--foreground")) {
    throw new Error("Usage: cabletidy start [--foreground] | stop");
  }
  if (command === "start" && args[1] !== "--foreground" && !existsSync(`${root}/Cargo.toml`)) {
    const runtime = await startBackground();
    console.log(`CableTidy started: ${runtime.web.url}\nLogs: ${runtime.logPath}`);
  } else {
    process.exitCode = await launch(command === "start" ? ["start"] : args).closed;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
