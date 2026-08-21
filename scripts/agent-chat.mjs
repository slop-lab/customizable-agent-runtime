#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDefaultRuntime, createProviderFromEnvironment } from "../packages/defaults/dist/index.js";
import { runAgentChat } from "./agent-chat-lib.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
const arguments_ = parseArguments(process.argv.slice(2));
const dataDirectory = process.env.CAR_DATA_DIR ?? join(process.cwd(), ".car");
mkdirSync(dataDirectory, { recursive: true });
const runtime = createDefaultRuntime({
  provider: createProviderFromEnvironment({ ...process.env, CAR_PROVIDER: process.env.CAR_PROVIDER ?? "openrouter" }),
  databasePath: join(dataDirectory, "runtime.sqlite"), artifactRoot: join(dataDirectory, "artifacts"),
  workspaceRoot: process.cwd(),
});
const terminal = createInterface({ input: stdin, output: stdout });

try {
  await runAgentChat({ runtime, terminal, output: stdout, dataDirectory,
    ...(arguments_.resume === undefined ? {} : { initialSessionId: arguments_.resume }) });
} finally {
  if (!terminal.closed) terminal.close();
  runtime.close();
}

function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--resume" && args[1]) return { resume: args[1] };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    stdout.write("usage: just chat [--resume SESSION_ID]\n"); process.exit();
  }
  throw new Error("usage: just chat [--resume SESSION_ID]");
}
