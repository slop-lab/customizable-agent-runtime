import { readFile } from "node:fs/promises";

export async function openRouterFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/openrouter/${name}.json`, import.meta.url), "utf8"));
}

export function replayFetch(fixture) {
  const requests = []; let responseIndex = 0;
  const fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)); requests.push(body);
    const response = fixture.responses[responseIndex++];
    if (!response) throw new Error(`Fixture ${fixture.name} received an unexpected request ${responseIndex}`);
    assertSubset(body, response.request ?? {}, "request");
    if (response.json !== undefined) return new Response(JSON.stringify(response.json), { status: response.status,
      headers: { "content-type": "application/json" } });
    return new Response(eventStream(response.chunks ?? [], response.delayMs ?? 0, init.signal), {
      status: response.status, headers: { "content-type": "text/event-stream" },
    });
  };
  return { fetch, requests, assertConsumed() {
    if (responseIndex !== fixture.responses.length) throw new Error(
      `Fixture ${fixture.name} consumed ${responseIndex}/${fixture.responses.length} responses`);
  } };
}

export function assertFixtureHasNoSecrets(value) {
  const text = JSON.stringify(value);
  const patterns = [/Bearer\s+[A-Za-z0-9._-]{8,}/i, /\bsk-[A-Za-z0-9_-]{12,}/, /AIza[0-9A-Za-z_-]{20,}/];
  for (const pattern of patterns) if (pattern.test(text)) throw new Error(`Fixture contains a secret-like value: ${pattern}`);
}

function eventStream(chunks, delayMs, signal) {
  const encoder = new TextEncoder(); let timer;
  return new ReadableStream({
    start(controller) {
      const write = () => {
        for (const chunk of chunks) {
          const frame = encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
          const midpoint = Math.max(1, Math.floor(frame.length / 2));
          controller.enqueue(frame.slice(0, midpoint)); controller.enqueue(frame.slice(midpoint));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close();
      };
      if (delayMs > 0) timer = setTimeout(write, delayMs); else write();
      signal?.addEventListener("abort", () => {
        if (timer) clearTimeout(timer);
        controller.error(signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    },
    cancel() { if (timer) clearTimeout(timer); },
  });
}
function assertSubset(actual, expected, path) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`${path} fixture mismatch`);
    expected.forEach((value, index) => assertSubset(actual[index], value, `${path}[${index}]`)); return;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) throw new Error(`${path} fixture mismatch`);
    for (const [key, value] of Object.entries(expected)) assertSubset(actual[key], value, `${path}.${key}`);
    return;
  }
  if (!Object.is(actual, expected)) throw new Error(`${path} fixture mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
