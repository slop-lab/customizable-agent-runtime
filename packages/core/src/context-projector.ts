import { createHash } from "node:crypto";
import type {
  ContextProjection,
  ContextTransform,
  ContextTransformDecision,
  ContextTransformResult,
  JsonObject,
  NormalizedContent,
} from "./agent-contracts.js";
import type { RecordEntry } from "./contracts.js";

export interface ContextProjectionOptions {
  readonly attemptNumber?: number;
  readonly transforms?: readonly ContextTransform[];
}

export class DefaultContextProjector {
  readonly id = "core.context.default";
  readonly version = "2";

  project(id: string, runId: string, records: readonly RecordEntry[], createdAt: string,
    options: ContextProjectionOptions = {}): ContextProjection {
    const projectedContent: NormalizedContent[] = [];
    const includedRecordIds: string[] = [];
    const excludedRecords: { recordId: string; reason: string }[] = [];
    for (const record of records) {
      const projected = projectRecord(record);
      if (projected) { projectedContent.push(projected); includedRecordIds.push(record.id); }
      else excludedRecords.push({ recordId: record.id, reason: `record kind ${record.kind} is not model-visible` });
    }
    let content: readonly NormalizedContent[] = projectedContent;
    validateToolStructure(content);
    const transformations: ContextProjection["transformations"][number][] = [];
    for (const transform of options.transforms ?? []) {
      const inputHash = contentHash(content);
      const result = transform.transform({ runId, attemptNumber: options.attemptNumber ?? 1, content });
      assertTransformResult(transform, result);
      content = [...result.content];
      validateToolStructure(content);
      transformations.push({ id: transform.id, version: transform.version,
        ...(transform.configuration === undefined ? {} : { configuration: transform.configuration }),
        inputHash, outputHash: contentHash(content), decisions: [...result.decisions] });
    }
    const requestHash = contentHash(content);
    return { id, runId, projectorId: this.id, projectorVersion: this.version,
      includedRecordIds, excludedRecords, content, transformations, requestHash, createdAt };
  }
}

export interface OldToolResultPruningOptions {
  readonly minimumCompletedToolExchanges?: number;
  readonly retainRecentToolExchanges?: number;
  readonly pruneBatchSize?: number;
  readonly protectedToolNames?: readonly string[];
}

export const oldToolResultTombstone = "[Old tool result removed by context policy]";

export class OldToolResultPruningTransform implements ContextTransform {
  readonly id = "core.context.old-tool-results";
  readonly version = "1";
  readonly configuration: JsonObject;
  readonly #minimumCompletedToolExchanges: number;
  readonly #retainRecentToolExchanges: number;
  readonly #pruneBatchSize: number;
  readonly #protectedToolNames: ReadonlySet<string>;

  constructor(options: OldToolResultPruningOptions = {}) {
    this.#minimumCompletedToolExchanges = options.minimumCompletedToolExchanges ?? 20;
    this.#retainRecentToolExchanges = options.retainRecentToolExchanges ?? 10;
    this.#pruneBatchSize = options.pruneBatchSize ?? 10;
    const protectedToolNames = [...new Set(options.protectedToolNames ?? ["skill", "todo", "plan"])].sort();
    for (const [name, value] of Object.entries({
      minimumCompletedToolExchanges: this.#minimumCompletedToolExchanges,
      retainRecentToolExchanges: this.#retainRecentToolExchanges,
      pruneBatchSize: this.#pruneBatchSize,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    if (this.#minimumCompletedToolExchanges < this.#retainRecentToolExchanges + this.#pruneBatchSize) {
      throw new TypeError("minimumCompletedToolExchanges must retain one complete pruning batch");
    }
    if (protectedToolNames.some((name) => name.length === 0)) {
      throw new TypeError("protectedToolNames must not contain empty names");
    }
    this.#protectedToolNames = new Set(protectedToolNames);
    this.configuration = { minimumCompletedToolExchanges: this.#minimumCompletedToolExchanges,
      retainRecentToolExchanges: this.#retainRecentToolExchanges, pruneBatchSize: this.#pruneBatchSize,
      protectedToolNames };
  }

  transform(input: { readonly content: readonly NormalizedContent[] }): ContextTransformResult {
    const openCalls = new Map<string, { readonly toolName: string }>();
    const eligible: { readonly index: number; readonly callId: string }[] = [];
    for (const [index, content] of input.content.entries()) {
      if (content.type === "tool-call") { openCalls.set(content.callId, { toolName: content.toolName }); continue; }
      if (content.type !== "tool-result") continue;
      const call = openCalls.get(content.callId);
      if (call !== undefined) openCalls.delete(content.callId);
      if (call !== undefined && !content.isError && !this.#protectedToolNames.has(call.toolName)) {
        eligible.push({ index, callId: content.callId });
      }
    }
    if (eligible.length < this.#minimumCompletedToolExchanges) return { content: input.content, decisions: [] };
    const available = Math.max(0, eligible.length - this.#retainRecentToolExchanges);
    const pruneCount = Math.floor(available / this.#pruneBatchSize) * this.#pruneBatchSize;
    if (pruneCount === 0) return { content: input.content, decisions: [] };
    const selected = new Map(eligible.slice(0, pruneCount).map((value) => [value.index, value.callId]));
    const decisions: ContextTransformDecision[] = [];
    const content = input.content.map((value, index) => {
      const callId = selected.get(index);
      if (callId === undefined || value.type !== "tool-result") return value;
      const projected = { ...value, output: oldToolResultTombstone };
      decisions.push({ action: "replace-tool-result-output", reason: "completed tool exchange exceeded retention window",
        contentIndex: index, callId, originalBytes: jsonBytes(value.output), projectedBytes: jsonBytes(projected.output) });
      return projected;
    });
    return { content, decisions };
  }
}

function projectRecord(record: RecordEntry): NormalizedContent | undefined {
  const data = record.data as Record<string, unknown>;
  if (record.kind === "user" || record.kind === "assistant") {
    const text = typeof data.text === "string" ? data.text : undefined;
    return text ? { type: "text", role: record.kind, text } : undefined;
  }
  if (record.kind === "tool-call" && typeof data.callId === "string" && typeof data.toolName === "string") {
    return { type: "tool-call", callId: data.callId, toolName: data.toolName, input: data.input };
  }
  if (record.kind === "tool-result" && typeof data.callId === "string") {
    return { type: "tool-result", callId: data.callId, output: data.output,
      isError: data.isError === true,
      ...(Array.isArray(data.artifacts) ? { artifacts: data.artifacts as NonNullable<
        Extract<NormalizedContent, { type: "tool-result" }>["artifacts"]> } : {}) };
  }
  if (record.kind === "provider-native" && typeof data.provider === "string") {
    return { type: "provider-native", provider: data.provider, value: data.value };
  }
  return undefined;
}

function contentHash(content: readonly NormalizedContent[]): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function assertTransformResult(transform: ContextTransform, result: ContextTransformResult): void {
  if (typeof result !== "object" || result === null || !Array.isArray(result.content) || !Array.isArray(result.decisions)) {
    throw new TypeError(`Context transform ${transform.id} returned an invalid result`);
  }
  for (const decision of result.decisions) {
    if (typeof decision !== "object" || decision === null || typeof decision.action !== "string" ||
      typeof decision.reason !== "string") {
      throw new TypeError(`Context transform ${transform.id} returned an invalid decision`);
    }
  }
}

function validateToolStructure(content: readonly NormalizedContent[]): void {
  const openCalls = new Set<string>();
  for (const item of content) {
    if (item.type === "tool-call") {
      if (openCalls.has(item.callId)) throw new TypeError(`Duplicate open tool call ID in context: ${item.callId}`);
      openCalls.add(item.callId);
    }
    if (item.type === "tool-result") {
      if (!openCalls.delete(item.callId)) throw new TypeError(`Tool result has no preceding call in context: ${item.callId}`);
    }
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "undefined");
}
