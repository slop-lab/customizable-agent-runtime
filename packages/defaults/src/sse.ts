export interface SseJsonOptions {
  readonly invalidJson?: (value: string, error: unknown) => Error;
}

export async function* parseSseJson(
  stream: ReadableStream<Uint8Array>, signal: AbortSignal, options: SseJsonOptions = {},
): AsyncIterable<unknown> {
  const decoder = new TextDecoder(); let buffer = "";
  for await (const bytes of stream) {
    signal.throwIfAborted(); buffer += decoder.decode(bytes, { stream: true });
    while (true) {
      const boundary = frameBoundary(buffer);
      if (!boundary) break;
      const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary.length);
      const value = parseFrame(frame, options);
      if (value !== undefined) yield value;
    }
  }
  buffer += decoder.decode();
  const value = parseFrame(buffer, options);
  if (value !== undefined) yield value;
}

function frameBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}
function parseFrame(frame: string, options: SseJsonOptions): unknown | undefined {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  if (!data || data.trim() === "[DONE]") return undefined;
  try { return JSON.parse(data) as unknown; }
  catch (error) { throw options.invalidJson?.(data, error) ?? error; }
}
