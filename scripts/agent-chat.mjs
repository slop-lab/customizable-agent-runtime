#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDefaultRuntime, createProviderFromEnvironment } from "../packages/defaults/dist/index.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const dataDirectory = process.env.CAR_DATA_DIR ?? join(process.cwd(), ".car");
mkdirSync(dataDirectory, { recursive: true });
const runtime = createDefaultRuntime({
  provider: createProviderFromEnvironment({ ...process.env, CAR_PROVIDER: process.env.CAR_PROVIDER ?? "google-ai-studio" }),
  databasePath: join(dataDirectory, "runtime.sqlite"),
  artifactRoot: join(dataDirectory, "artifacts"),
  workspaceRoot: process.cwd(),
});
const terminal = createInterface({ input: stdin, output: stdout });

try {
  const session = await runtime.createSession();
  stdout.write(`CAR interactive agent\nsession: ${session.id}\ndata: ${dataDirectory}\nType /help for commands.\n\n`);
  terminal.setPrompt("you> ");
  prompt();
  for await (const line of terminal) {
    const input = line.trim();
    if (!input) { prompt(); continue; }
    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") {
      stdout.write("/help  show commands\n/id    show the current session ID\n/exit  quit\n\n");
      prompt(); continue;
    }
    if (input === "/id") {
      stdout.write(`${session.id}\n\n`);
      prompt(); continue;
    }

    const before = runtime.getRecords(session.id).length;
    const run = await runtime.run(session.id, input);
    const records = runtime.getRecords(session.id).slice(before + 1);
    for (const record of records) {
      const data = record.data ?? {};
      if (record.kind === "tool-call") stdout.write(`[tool] ${data.toolName} ${JSON.stringify(data.input)}\n`);
      else if (record.kind === "tool-result" && data.isError) stdout.write(`[tool error] ${format(data.output)}\n`);
      else if (record.kind === "assistant") stdout.write(`agent> ${data.text}\n`);
      else if (record.kind === "error") stdout.write(`[run error] ${data.message}\n`);
    }
    stdout.write(`[run ${run.status}: ${run.id}]\n\n`);
    prompt();
  }
} finally {
  if (!terminal.closed) terminal.close();
  runtime.close();
}

function prompt() { if (!terminal.closed) terminal.prompt(); }
function format(value) { return typeof value === "string" ? value : JSON.stringify(value); }
