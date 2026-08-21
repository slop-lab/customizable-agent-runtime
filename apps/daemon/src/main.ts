#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createDefaultRuntime } from "@car/defaults";

const runtime = createDefaultRuntime();
const host = process.env.CAR_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.CAR_PORT ?? "4317", 10);

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/capabilities") {
    send(response, 200, runtime.capabilities());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    send(response, 201, runtime.createSession());
    return;
  }

  const recordsMatch = /^\/v1\/sessions\/([^/]+)\/records$/.exec(url.pathname);
  if (request.method === "GET" && recordsMatch?.[1]) {
    send(response, 200, runtime.getRecords(recordsMatch[1]));
    return;
  }

  const runsMatch = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(url.pathname);
  if (request.method === "POST" && runsMatch?.[1]) {
    const body = await readJson(request);
    if (!isRunBody(body)) {
      send(response, 400, { error: "Expected JSON body with a string input." });
      return;
    }
    send(response, 201, await runtime.run(runsMatch[1], body.input));
    return;
  }

  const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancelMatch?.[1]) {
    send(response, runtime.cancelRun(cancelMatch[1]) ? 202 : 404, {});
    return;
  }

  send(response, 404, { error: "Not found" });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRunBody(value: unknown): value is { input: string } {
  return typeof value === "object" && value !== null && "input" in value &&
    typeof (value as { input?: unknown }).input === "string";
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

server.listen(port, host, () => {
  process.stdout.write(`CAR daemon listening on http://${host}:${port}\n`);
});
