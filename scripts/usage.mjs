#!/usr/bin/env node
const options = parseArguments(process.argv.slice(2));
const url = new URL("/v1/usage", options.baseUrl);
if (options.sessionId) url.searchParams.set("sessionId", options.sessionId);
if (options.runId) url.searchParams.set("runId", options.runId);

let response;
try { response = await fetch(url); }
catch (error) {
  process.stderr.write(`Could not reach CAR at ${options.baseUrl}. Start it with \`just start\`.\n` +
    `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  process.exit();
}
const body = await response.json();
if (!response.ok) {
  process.stderr.write(`CAR usage request failed (${response.status}): ${body.error ?? JSON.stringify(body)}\n`);
  process.exitCode = 1;
} else if (options.json) {
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
} else {
  printReport(body);
}

function parseArguments(args) {
  const result = { json: false, baseUrl: process.env.CAR_BASE_URL ?? "http://127.0.0.1:4317" };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") result.json = true;
    else if (arg === "--session") result.sessionId = requiredValue(args, ++index, arg);
    else if (arg === "--run") result.runId = requiredValue(args, ++index, arg);
    else if (arg === "--base-url") result.baseUrl = requiredValue(args, ++index, arg);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: just usage [--json] [--session ID] [--run ID] [--base-url URL]\n");
      process.exit();
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}
function requiredValue(args, index, option) {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}
function printReport(report) {
  const totals = report.totals;
  process.stdout.write("CAR usage\n");
  if (report.filter.sessionId) process.stdout.write(`session: ${report.filter.sessionId}\n`);
  if (report.filter.runId) process.stdout.write(`run: ${report.filter.runId}\n`);
  process.stdout.write(`sessions: ${totals.sessions}  runs: ${totals.runs}\n` +
    `model requests: ${totals.modelRequests}  retries: ${totals.retries}\n` +
    `outcomes: ${Object.entries(totals.outcomes).map(([key, value]) => `${key}=${value}`).join(" ")}\n` +
    `tokens: ${formatTokens(totals.tokens)}\n` +
    `cost: ${totals.costUsd === undefined ? "unknown" : `$${totals.costUsd.toFixed(6)}`} ` +
    `(reported by ${totals.coverage.cost}/${totals.modelRequests} requests)\n` +
    `normalized usage: ${totals.coverage.normalizedUsage}/${totals.modelRequests} requests\n`);
  if (report.byProviderModel.length > 0) {
    process.stdout.write("\nprovider/model\n");
    for (const group of report.byProviderModel) process.stdout.write(
      `- ${group.key}: requests=${group.modelRequests} retries=${group.retries} ` +
      `tokens=${group.tokens.totalTokens ?? "unknown"} cost=${group.costUsd === undefined ? "unknown" : `$${group.costUsd.toFixed(6)}`}\n`);
  }
  if (Object.keys(totals.errorCodes).length > 0) {
    process.stdout.write(`\nerrors: ${Object.entries(totals.errorCodes).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
  }
}
function formatTokens(tokens) {
  const values = [["input", tokens.inputTokens], ["output", tokens.outputTokens],
    ["reasoning", tokens.reasoningTokens], ["cache-read", tokens.cacheReadTokens],
    ["cache-write", tokens.cacheWriteTokens], ["total", tokens.totalTokens]]
    .filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`);
  return values.length === 0 ? "unknown" : values.join(" ");
}
