#!/usr/bin/env node
import { launch } from "./native.mjs";

try {
  process.exitCode = await launch(process.argv.slice(2)).closed;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
