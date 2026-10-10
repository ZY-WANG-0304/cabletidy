#!/usr/bin/env node
import { existsSync } from "node:fs";
import { launch, root, startBackground } from "./native.mjs";
import { update } from "./update.mjs";

try {
  const args = process.argv.slice(2);
  const command = args[0] || "status";
  const starts = ["start", "restart"].includes(command);
  if ((starts || command === "stop") && args.length > 1 && !(starts && args.length === 2 && args[1] === "--foreground")) {
    throw new Error("Usage: cabletidy start [--foreground] | restart [--foreground] | stop");
  }
  if (command === "update") {
    process.exitCode = await update(args.slice(1));
  } else if (starts && args[1] !== "--foreground" && !existsSync(`${root}/Cargo.toml`)) {
    const code = command === "restart" ? await launch(["stop"]).closed : 0;
    if (code !== 0) {
      process.exitCode = code;
    } else {
      const runtime = await startBackground();
      console.log(`CableTidy ${command === "restart" ? "restarted" : "started"}: ${runtime.web.url}\nLogs: ${runtime.logPath}`);
    }
  } else {
    process.exitCode = await launch(starts ? [command] : args).closed;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
