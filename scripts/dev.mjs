import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , command = "start", ...args] = process.argv;

try {
  if (args.length || !["start", "status"].includes(command)) {
    throw new Error("Usage: node scripts/dev.mjs [start|status]");
  }

  const home = path.resolve(process.env.CABLETIDY_DEV_HOME ||
    fileURLToPath(new URL("../.cabletidy-debug/", import.meta.url)));
  // Select the store before importing modules that capture CABLETIDY_HOME.
  process.env.CABLETIDY_HOME = home;

  if (command === "status") {
    await import("../src/cli.mjs");
  } else {
    const { startDaemon } = await import("../src/server.mjs");
    console.log("CableTidy development instance");
    await startDaemon({
      preferredPort: 43101,
      codexHome: path.join(home, "codex"),
      claudeHome: path.join(home, "claude"),
    });
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
