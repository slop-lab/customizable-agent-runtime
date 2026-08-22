import { createHash } from "node:crypto";
import type { ContextProjection, NormalizedContent } from "./agent-contracts.js";
import type { RecordEntry } from "./contracts.js";

export class DefaultContextProjector {
  readonly id = "core.context.default";
  readonly version = "1";

  project(id: string, runId: string, records: readonly RecordEntry[], createdAt: string): ContextProjection {
    const content: NormalizedContent[] = [];
    const includedRecordIds: string[] = [];
    const excludedRecords: { recordId: string; reason: string }[] = [];
    for (const record of records) {
      const projected = projectRecord(record);
      if (projected) { content.push(projected); includedRecordIds.push(record.id); }
      else excludedRecords.push({ recordId: record.id, reason: `record kind ${record.kind} is not model-visible` });
    }
    const requestHash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    return { id, runId, projectorId: this.id, projectorVersion: this.version,
      includedRecordIds, excludedRecords, content, requestHash, createdAt };
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
