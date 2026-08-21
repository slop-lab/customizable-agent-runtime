import type { ModelAttempt, ModelAttemptStatus, NormalizedUsageV1 } from "./agent-contracts.js";

export interface UsageFilter {
  readonly sessionId?: string;
  readonly runId?: string;
}

export interface UsageAttempt {
  readonly sessionId: string;
  readonly attempt: ModelAttempt;
}

export interface UsageCounters {
  readonly sessions: number;
  readonly runs: number;
  readonly modelRequests: number;
  readonly retries: number;
  readonly outcomes: Readonly<Record<ModelAttemptStatus, number>>;
  readonly errorCodes: Readonly<Record<string, number>>;
  readonly tokens: Omit<NormalizedUsageV1, "version" | "costUsd">;
  readonly costUsd?: number;
  readonly coverage: {
    readonly normalizedUsage: number;
    readonly cost: number;
  };
}

export interface UsageGroup extends UsageCounters {
  readonly key: string;
}

export interface UsageReport {
  readonly version: 1;
  readonly filter: UsageFilter;
  readonly totals: UsageCounters;
  readonly byProviderModel: readonly UsageGroup[];
  readonly bySession: readonly UsageGroup[];
  readonly byRun: readonly UsageGroup[];
}

export function aggregateUsage(attempts: readonly UsageAttempt[], filter: UsageFilter = {}): UsageReport {
  return { version: 1, filter, totals: counters(attempts),
    byProviderModel: groups(attempts, ({ attempt }) =>
      `${attempt.providerProfile.provider}/${attempt.providerProfile.model}`),
    bySession: groups(attempts, (value) => value.sessionId),
    byRun: groups(attempts, ({ attempt }) => attempt.runId) };
}

function groups(attempts: readonly UsageAttempt[], keyOf: (attempt: UsageAttempt) => string): readonly UsageGroup[] {
  const grouped = new Map<string, UsageAttempt[]>();
  for (const attempt of attempts) {
    const key = keyOf(attempt);
    const values = grouped.get(key) ?? [];
    values.push(attempt); grouped.set(key, values);
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => ({ key, ...counters(values) }));
}

function counters(values: readonly UsageAttempt[]): UsageCounters {
  const sessions = new Set<string>(); const runs = new Set<string>();
  const outcomes: Record<ModelAttemptStatus, number> = {
    running: 0, completed: 0, failed: 0, cancelled: 0, abandoned: 0,
  };
  const errorCodes: Record<string, number> = {};
  const tokenSums: Record<Exclude<keyof NormalizedUsageV1, "version" | "costUsd">, number> = {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, totalTokens: 0,
  };
  const tokenCoverage = new Set<keyof typeof tokenSums>();
  let retries = 0; let normalizedUsage = 0; let costCoverage = 0; let costUsd = 0;
  for (const value of values) {
    const attempt = value.attempt;
    sessions.add(value.sessionId); runs.add(attempt.runId); outcomes[attempt.status]++;
    if (attempt.retryOfAttemptId !== undefined) retries++;
    const code = typeof attempt.error?.code === "string" ? attempt.error.code : undefined;
    if (code) errorCodes[code] = (errorCodes[code] ?? 0) + 1;
    if (attempt.normalizedUsage) {
      normalizedUsage++;
      for (const key of Object.keys(tokenSums) as (keyof typeof tokenSums)[]) {
        const number = attempt.normalizedUsage[key];
        if (number !== undefined) { tokenSums[key] += number; tokenCoverage.add(key); }
      }
      if (attempt.normalizedUsage.costUsd !== undefined) {
        costCoverage++; costUsd += attempt.normalizedUsage.costUsd;
      }
    }
  }
  const tokens: Partial<typeof tokenSums> = {};
  for (const key of tokenCoverage) tokens[key] = tokenSums[key];
  return { sessions: sessions.size, runs: runs.size, modelRequests: values.length, retries,
    outcomes, errorCodes: Object.fromEntries(Object.entries(errorCodes).sort(([a], [b]) => a.localeCompare(b))),
    tokens, ...(costCoverage > 0 ? { costUsd } : {}),
    coverage: { normalizedUsage, cost: costCoverage } };
}
