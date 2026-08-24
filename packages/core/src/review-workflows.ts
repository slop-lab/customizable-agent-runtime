import type { JsonObject } from "./agent-contracts.js";
import { RuntimeError } from "./errors.js";
import { canonicalJson, hashCanonicalJson, type ComponentIdentity } from "./provenance.js";
import type { KernelDatabase } from "./storage.js";
import { defaultRuntimeSystem, type RuntimeSystem } from "./system.js";

export type ReviewStageKind =
  | "protected-base"
  | "implementation"
  | "pull-request"
  | "automated-check"
  | "agent-review"
  | "human-approval"
  | "custom";

export type ReviewEvidenceSourceKind = "agent" | "tool" | "ci" | "human" | "git-host" | "system";

export interface ReviewEvidenceRequirement {
  readonly type: string;
  readonly acceptedSourceKinds: readonly ReviewEvidenceSourceKind[];
  readonly requiredPayloadFields?: readonly string[];
}

export interface ReviewStage {
  readonly id: string;
  readonly label: string;
  readonly kind: ReviewStageKind;
  readonly required: boolean;
  readonly dependsOn: readonly string[];
  readonly evidence: ReviewEvidenceRequirement;
}

export interface ReviewWorkflowPlan {
  readonly stages: readonly ReviewStage[];
}

export interface ReviewEnforcement {
  readonly pullRequestRequired: true;
  readonly protectedBaseRequired: true;
  readonly minimumHumanApprovals: number;
  readonly invalidateOnHeadChange: true;
}

export interface ReviewEvidenceSource {
  readonly kind: ReviewEvidenceSourceKind;
  readonly id: string;
}

export interface ReviewEvidenceInput {
  readonly externalEventId: string;
  readonly type: string;
  readonly commitSha: string;
  readonly source: ReviewEvidenceSource;
  readonly payload?: JsonObject;
}

export interface ReviewEvidence extends ReviewEvidenceInput {
  readonly id: string;
  readonly workflowId: string;
  readonly recordedRevision: number;
  readonly payload: JsonObject;
  readonly assurance: "asserted" | "attested";
  readonly createdAt: string;
}

export interface ReviewStageResult {
  readonly id: string;
  readonly workflowId: string;
  readonly recordedRevision: number;
  readonly stageId: string;
  readonly stageGateHash: string;
  readonly commitSha: string;
  readonly evidenceId: string;
  readonly createdAt: string;
}

export type ReviewRevisionCause =
  | { readonly kind: "created" }
  | { readonly kind: "evidence-recorded"; readonly evidenceId: string }
  | { readonly kind: "stage-completed"; readonly stageId: string; readonly evidenceId: string }
  | { readonly kind: "head-changed"; readonly previousHeadSha: string; readonly evidenceId: string };

export interface ReviewWorkflowRevision {
  readonly workflowId: string;
  readonly revision: number;
  readonly plan: ReviewWorkflowPlan;
  readonly planHash: string;
  readonly cause: ReviewRevisionCause;
  readonly createdAt: string;
}

export interface ReviewWorkflow {
  readonly id: string;
  readonly projectId: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly enforcement: ReviewEnforcement;
  readonly provider: ComponentIdentity;
  readonly providerConfiguration: JsonObject;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewStageState {
  readonly stage: ReviewStage;
  readonly state: "pending" | "blocked" | "completed";
  readonly incompleteDependencies: readonly string[];
  readonly result?: ReviewStageResult;
}

export interface ReviewMergeReadiness {
  readonly ready: boolean;
  readonly publishable: boolean;
  readonly assurance: "operator-asserted" | "attested";
  readonly blockers: readonly string[];
  readonly attestationBlockers: readonly string[];
  readonly humanApprovals: number;
}

export interface ReviewWorkflowSummary {
  readonly workflow: ReviewWorkflow;
  readonly current: ReviewWorkflowRevision;
  readonly stages: readonly ReviewStageState[];
  readonly mergeReadiness: ReviewMergeReadiness;
  readonly historyCounts: {
    readonly revisions: number;
    readonly evidence: number;
    readonly stageResults: number;
  };
}

export interface ReviewWorkflowHistoryPage {
  readonly revisions: readonly ReviewWorkflowRevision[];
  readonly evidence: readonly ReviewEvidence[];
  readonly stageResults: readonly ReviewStageResult[];
  readonly nextBeforeRevision?: number;
}

export interface CreateReviewWorkflowInput {
  readonly projectId: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly minimumHumanApprovals?: number;
  readonly provider?: {
    readonly id: string;
    readonly version?: string;
    readonly configuration?: JsonObject;
  };
}

export interface CompleteReviewStageInput {
  readonly expectedRevision: number;
  readonly stageId: string;
  readonly evidence: ReviewEvidenceInput;
}

export interface UpdateReviewWorkflowHeadInput {
  readonly expectedRevision: number;
  readonly headSha: string;
  readonly externalEventId: string;
  readonly source: ReviewEvidenceSource;
}

export type ReviewWorkflowAmendment =
  | { readonly type: "add-stage"; readonly stage: ReviewStage }
  | { readonly type: "add-dependency"; readonly stageId: string; readonly dependsOn: string };

export interface ReviewWorkflowProvider {
  readonly identity: ComponentIdentity;
  create(input: {
    readonly projectId: string;
    readonly repository: string;
    readonly baseBranch: string;
    readonly enforcement: ReviewEnforcement;
    readonly configuration: JsonObject;
  }): ReviewWorkflowPlan;
  revise(input: {
    readonly workflow: ReviewWorkflow;
    readonly plan: ReviewWorkflowPlan;
    readonly recentEvidence: readonly ReviewEvidence[];
    readonly evidenceWindow: { readonly limit: 100; readonly total: number; readonly truncated: boolean };
    readonly latestEvidence: ReviewEvidence;
  }): readonly ReviewWorkflowAmendment[];
}

export class DeclarativeReviewWorkflowProvider implements ReviewWorkflowProvider {
  readonly identity = { id: "core.review.declarative", version: "1" } as const;

  create(input: { readonly configuration: JsonObject }): ReviewWorkflowPlan {
    const stages = input.configuration.stages;
    if (!Array.isArray(stages)) {
      throw new RuntimeError("validation", "Declarative review provider requires a stages array");
    }
    return { stages: stages.map((stage, index) => configuredStage(stage, index)) };
  }

  revise(): readonly ReviewWorkflowAmendment[] { return []; }
}

export class AdaptiveReviewWorkflowProvider implements ReviewWorkflowProvider {
  readonly identity = { id: "core.review.adaptive", version: "1" } as const;

  create(): ReviewWorkflowPlan { return defaultReviewWorkflowPlan(); }

  revise(input: { readonly latestEvidence: ReviewEvidence }): readonly ReviewWorkflowAmendment[] {
    if (input.latestEvidence.type !== "risk.detected") return [];
    const category = input.latestEvidence.payload.category;
    if (typeof category !== "string" || category.trim().length === 0) return [];
    const normalizedCategory = category.trim().toLowerCase();
    const slug = stageSlug(normalizedCategory);
    const suffix = hashCanonicalJson(normalizedCategory).slice(0, 8);
    const stageId = slug === "security" ? "security-review" : `risk-review-${slug}-${suffix}`;
    const label = slug === "security" ? "Security review" : `Risk review: ${normalizedCategory}`;
    return [
      { type: "add-stage", stage: { id: stageId, label, kind: "agent-review", required: true,
        dependsOn: ["automated-checks"], evidence: {
          type: "review.agent.approved", acceptedSourceKinds: ["agent"],
        } } },
      { type: "add-dependency", stageId: "code-review", dependsOn: stageId },
    ];
  }
}

export function defaultReviewWorkflowPlan(): ReviewWorkflowPlan {
  return { stages: [
    { id: "base-protection", label: "Verify protected base", kind: "protected-base", required: true,
      dependsOn: [], evidence: { type: "git.base.protected", acceptedSourceKinds: ["git-host"] } },
    { id: "implementation", label: "Implementation", kind: "implementation", required: true, dependsOn: [],
      evidence: { type: "implementation.completed", acceptedSourceKinds: ["agent", "human"] } },
    { id: "pull-request", label: "Open pull request", kind: "pull-request", required: true,
      dependsOn: ["implementation"], evidence: {
        type: "git.pull-request.opened", acceptedSourceKinds: ["git-host"],
      } },
    { id: "automated-checks", label: "Automated checks", kind: "automated-check", required: true,
      dependsOn: ["pull-request"], evidence: { type: "check.passed", acceptedSourceKinds: ["ci", "tool"] } },
    { id: "code-review", label: "Code review", kind: "agent-review", required: true,
      dependsOn: ["automated-checks"], evidence: {
        type: "review.agent.approved", acceptedSourceKinds: ["agent"],
      } },
    { id: "human-approval", label: "Human approval", kind: "human-approval", required: true,
      dependsOn: ["base-protection", "code-review"], evidence: {
        type: "review.human.approved", acceptedSourceKinds: ["human"],
      } },
  ] };
}

const defaultProviders = (): readonly ReviewWorkflowProvider[] => [
  new AdaptiveReviewWorkflowProvider(),
  new DeclarativeReviewWorkflowProvider(),
];

type Row = Readonly<Record<string, unknown>>;

export class ReviewWorkflowService {
  readonly #providers: ReadonlyMap<string, ReviewWorkflowProvider>;
  readonly #providerIdentities: ReadonlyMap<string, ComponentIdentity>;

  constructor(
    readonly database: KernelDatabase,
    readonly system: RuntimeSystem = defaultRuntimeSystem,
    providers?: readonly ReviewWorkflowProvider[],
  ) {
    const mapped = new Map<string, ReviewWorkflowProvider>();
    const identities = new Map<string, ComponentIdentity>();
    for (const provider of [...defaultProviders(), ...(providers ?? [])]) {
      validateIdentifier(provider.identity.id, "Review workflow provider id", 120);
      validateIdentifier(provider.identity.version, "Review workflow provider version", 40);
      const identity = immutableJsonClone<ComponentIdentity>(provider.identity);
      const key = providerKey(identity.id, identity.version);
      if (mapped.has(key)) {
        throw new RuntimeError("validation", `Duplicate review workflow provider: ${providerLabel(identity)}`);
      }
      mapped.set(key, provider);
      identities.set(key, identity);
    }
    this.#providers = mapped;
    this.#providerIdentities = identities;
  }

  providers(): readonly ComponentIdentity[] {
    return [...this.#providerIdentities.values()]
      .sort((left, right) => compareStrings(left.id, right.id) || compareStrings(left.version, right.version));
  }

  async create(input: CreateReviewWorkflowInput): Promise<ReviewWorkflowSummary> {
    const normalized = validateCreateInput(input);
    const selected = this.#selectProvider(normalized.providerId, normalized.providerVersion);
    const provider = selected.provider;
    const enforcement: ReviewEnforcement = { pullRequestRequired: true, protectedBaseRequired: true,
      minimumHumanApprovals: normalized.minimumHumanApprovals, invalidateOnHeadChange: true };
    const providerInput = immutableJsonClone({ projectId: normalized.projectId, repository: normalized.repository,
      baseBranch: normalized.baseBranch, enforcement, configuration: normalized.configuration });
    const plan = validatePlan(provider.create(providerInput), enforcement);
    const now = this.system.clock.now();
    const workflow: ReviewWorkflow = { id: this.system.ids.next(), projectId: normalized.projectId,
      repository: normalized.repository, baseBranch: normalized.baseBranch, headSha: normalized.headSha,
      enforcement: immutableJsonClone(enforcement), provider: selected.identity,
      providerConfiguration: immutableJsonClone(normalized.configuration),
      currentRevision: 1, createdAt: now, updatedAt: now };
    await this.database.writer.run(() => this.database.transaction(() => {
      this.database.db.prepare(`INSERT INTO review_workflows(
        id, project_id, repository, base_branch, head_sha, enforcement_json, provider_id, provider_version,
        provider_configuration_json, current_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workflow.id, workflow.projectId, workflow.repository,
        workflow.baseBranch, workflow.headSha, JSON.stringify(workflow.enforcement), workflow.provider.id,
        workflow.provider.version, JSON.stringify(workflow.providerConfiguration), workflow.currentRevision,
        workflow.createdAt, workflow.updatedAt);
      this.#insertRevision(workflow.id, 1, plan, { kind: "created" }, now);
    }));
    return this.get(workflow.id)!;
  }

  get(id: string): ReviewWorkflowSummary | undefined {
    const row = this.database.db.prepare("SELECT * FROM review_workflows WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return this.#summary(workflowFromRow(row));
  }

  list(limit = 50): readonly ReviewWorkflowSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RuntimeError("validation", "Limit must be an integer from 1 through 100");
    }
    const rows = this.database.db.prepare(
      "SELECT * FROM review_workflows ORDER BY updated_at DESC, id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((row) => this.#summary(workflowFromRow(row)));
  }

  history(id: string, options: { readonly limit?: number; readonly beforeRevision?: number } = {}):
  ReviewWorkflowHistoryPage {
    const workflow = this.#requiredWorkflow(id);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RuntimeError("validation", "History limit must be an integer from 1 through 100");
    }
    const beforeRevision = options.beforeRevision ?? workflow.currentRevision + 1;
    if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 2 ||
      beforeRevision > workflow.currentRevision + 1) {
      throw new RuntimeError("validation", "History beforeRevision must identify a workflow revision boundary");
    }
    const revisions = (this.database.db.prepare(`SELECT * FROM review_workflow_revisions
      WHERE workflow_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?`)
      .all(id, beforeRevision, limit) as Row[]).map(revisionFromRow);
    if (revisions.length === 0) return { revisions: [], evidence: [], stageResults: [] };
    const newestRevision = revisions[0]!.revision;
    const oldestRevision = revisions[revisions.length - 1]!.revision;
    const evidence = (this.database.db.prepare(`SELECT * FROM review_workflow_evidence
      WHERE workflow_id = ? AND recorded_revision BETWEEN ? AND ? ORDER BY recorded_revision DESC`)
      .all(id, oldestRevision, newestRevision) as Row[]).map(evidenceFromRow);
    const stageResults = (this.database.db.prepare(`SELECT * FROM review_workflow_stage_results
      WHERE workflow_id = ? AND recorded_revision BETWEEN ? AND ? ORDER BY recorded_revision DESC`)
      .all(id, oldestRevision, newestRevision) as Row[]).map(stageResultFromRow);
    return { revisions, evidence, stageResults,
      ...(oldestRevision > 1 ? { nextBeforeRevision: oldestRevision } : {}) };
  }

  async appendEvidence(id: string, expectedRevision: number,
    input: ReviewEvidenceInput): Promise<ReviewWorkflowSummary> {
    return this.database.writer.run(() => this.database.transaction(() => {
      const workflow = this.#requiredWorkflow(id);
      validateEvidenceShape(input);
      const replay = this.#evidenceByExternalEventId(id, input.externalEventId.trim());
      if (replay) { assertEvidenceReplay(replay, input); return this.#summary(workflow); }
      assertExpectedRevision(workflow, expectedRevision);
      const evidence = this.#newEvidence(workflow, workflow.currentRevision + 1, input);
      this.#insertEvidence(evidence);
      const plan = this.#revisedPlan(workflow, this.#currentRevision(workflow.id).plan, evidence);
      this.#advance(workflow, plan, { kind: "evidence-recorded", evidenceId: evidence.id }, evidence.createdAt);
      return this.#summary(this.#requiredWorkflow(id));
    }));
  }

  async completeStage(id: string, input: CompleteReviewStageInput): Promise<ReviewWorkflowSummary> {
    return this.database.writer.run(() => this.database.transaction(() => {
      if (!input || typeof input !== "object") {
        throw new RuntimeError("validation", "Review stage completion input must be an object");
      }
      const workflow = this.#requiredWorkflow(id);
      validateStageId(input.stageId);
      validateEvidenceShape(input.evidence);
      const replay = this.#evidenceByExternalEventId(id, input.evidence.externalEventId.trim());
      if (replay) {
        assertEvidenceReplay(replay, input.evidence);
        const result = this.database.db.prepare(`SELECT id FROM review_workflow_stage_results
          WHERE workflow_id = ? AND stage_id = ? AND evidence_id = ?`).get(id, input.stageId, replay.id);
        if (!result) throw new RuntimeError("conflict", "External event was recorded for a different workflow action");
        return this.#summary(workflow);
      }
      assertExpectedRevision(workflow, input.expectedRevision);
      const nextRevision = workflow.currentRevision + 1;
      const evidence = this.#newEvidence(workflow, nextRevision, input.evidence);
      this.#insertEvidence(evidence);
      const plan = this.#revisedPlan(workflow, this.#currentRevision(workflow.id).plan, evidence);
      const stage = plan.stages.find((value) => value.id === input.stageId);
      if (!stage) throw new RuntimeError("not-found", `Unknown review stage: ${input.stageId}`);
      validateStageEvidence(stage, evidence);
      const stageStates = deriveStageStates(plan, workflow.headSha,
        this.#stageResultsForPlan(workflow.id, workflow.headSha, plan));
      const state = stageStates.find((value) => value.stage.id === stage.id)!;
      if (state.state === "completed") throw new RuntimeError("conflict", `Review stage is already complete: ${stage.id}`);
      if (state.incompleteDependencies.length > 0) {
        throw new RuntimeError("conflict", `Review stage has incomplete dependencies: ${stage.id}`, {
          incompleteDependencies: state.incompleteDependencies,
        });
      }
      const result: ReviewStageResult = { id: this.system.ids.next(), workflowId: workflow.id,
        recordedRevision: nextRevision, stageId: stage.id, stageGateHash: stageGateHash(plan, stage.id),
        commitSha: workflow.headSha, evidenceId: evidence.id, createdAt: evidence.createdAt };
      this.#insertStageResult(result);
      this.#advance(workflow, plan, { kind: "stage-completed", stageId: stage.id, evidenceId: evidence.id },
        evidence.createdAt);
      return this.#summary(this.#requiredWorkflow(id));
    }));
  }

  async updateHead(id: string, input: UpdateReviewWorkflowHeadInput): Promise<ReviewWorkflowSummary> {
    return this.database.writer.run(() => this.database.transaction(() => {
      if (!input || typeof input !== "object") {
        throw new RuntimeError("validation", "Review head update input must be an object");
      }
      const workflow = this.#requiredWorkflow(id);
      validateExternalEventId(input.externalEventId);
      validateHeadSha(input.headSha);
      validateEvidenceSource(input.source);
      const headSha = input.headSha.toLowerCase();
      const replay = this.#evidenceByExternalEventId(id, input.externalEventId.trim());
      if (replay) {
        if (replay.type !== "git.head.changed" || replay.commitSha !== headSha ||
          replay.source.kind !== input.source.kind || replay.source.id !== input.source.id.trim()) {
          throw new RuntimeError("conflict", "External event id is already used by different evidence");
        }
        return this.#summary(workflow);
      }
      assertExpectedRevision(workflow, input.expectedRevision);
      if (workflow.headSha === headSha) throw new RuntimeError("conflict", "The workflow already targets that head SHA");
      const now = this.system.clock.now();
      const nextRevision = workflow.currentRevision + 1;
      const evidenceInput: ReviewEvidenceInput = { externalEventId: input.externalEventId,
        type: "git.head.changed", commitSha: headSha, source: input.source,
        payload: { previousHeadSha: workflow.headSha } };
      validateEvidenceInput(evidenceInput, headSha);
      const evidence: ReviewEvidence = { id: this.system.ids.next(), workflowId: workflow.id,
        recordedRevision: nextRevision, externalEventId: input.externalEventId.trim(), type: "git.head.changed",
        commitSha: headSha, source: { kind: input.source.kind, id: input.source.id.trim() },
        payload: { previousHeadSha: workflow.headSha }, assurance: "asserted", createdAt: now };
      this.#insertEvidence(evidence);
      this.database.db.prepare("UPDATE review_workflows SET head_sha = ? WHERE id = ?").run(headSha, workflow.id);
      const updated = { ...workflow, headSha };
      const plan = this.#revisedPlan(updated, this.#currentRevision(workflow.id).plan, evidence);
      this.#advance(updated, plan, { kind: "head-changed", previousHeadSha: workflow.headSha,
        evidenceId: evidence.id }, now);
      return this.#summary(this.#requiredWorkflow(id));
    }));
  }

  #selectProvider(id: string, version?: string): {
    readonly provider: ReviewWorkflowProvider; readonly identity: ComponentIdentity;
  } {
    if (version !== undefined) {
      const key = providerKey(id, version);
      const provider = this.#providers.get(key);
      const identity = this.#providerIdentities.get(key);
      if (!provider || !identity) {
        throw new RuntimeError("validation", `Unknown review workflow provider: ${providerLabel({ id, version })}`);
      }
      return { provider, identity };
    }
    const matches = [...this.#providerIdentities.entries()].filter(([, identity]) => identity.id === id);
    if (matches.length === 0) throw new RuntimeError("validation", `Unknown review workflow provider: ${id}`);
    if (matches.length > 1) {
      throw new RuntimeError("validation", `Review workflow provider version is required: ${id}`,
        { versions: matches.map(([, identity]) => identity.version).sort(compareStrings) });
    }
    const [key, identity] = matches[0]!;
    return { provider: this.#providers.get(key)!, identity };
  }

  #providerForWorkflow(workflow: ReviewWorkflow): ReviewWorkflowProvider {
    const provider = this.#providers.get(providerKey(workflow.provider.id, workflow.provider.version));
    if (!provider) {
      throw new RuntimeError("conflict", `Review workflow provider version is unavailable: ${workflow.provider.id}@${workflow.provider.version}`);
    }
    return provider;
  }

  #requiredWorkflow(id: string): ReviewWorkflow {
    const row = this.database.db.prepare("SELECT * FROM review_workflows WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new RuntimeError("not-found", `Unknown review workflow: ${id}`);
    return workflowFromRow(row);
  }

  #newEvidence(workflow: ReviewWorkflow, recordedRevision: number, input: ReviewEvidenceInput): ReviewEvidence {
    validateEvidenceInput(input, workflow.headSha);
    return { id: this.system.ids.next(), workflowId: workflow.id, recordedRevision,
      externalEventId: input.externalEventId.trim(), type: input.type.trim(),
      commitSha: input.commitSha.toLowerCase(), source: { kind: input.source.kind, id: input.source.id.trim() },
      payload: immutableJsonClone(input.payload ?? {}), assurance: "asserted",
      createdAt: this.system.clock.now() };
  }

  #evidenceByExternalEventId(workflowId: string, externalEventId: string): ReviewEvidence | undefined {
    const row = this.database.db.prepare(`SELECT * FROM review_workflow_evidence
      WHERE workflow_id = ? AND external_event_id = ?`).get(workflowId, externalEventId) as Row | undefined;
    return row ? evidenceFromRow(row) : undefined;
  }

  #revisedPlan(workflow: ReviewWorkflow, current: ReviewWorkflowPlan,
    latestEvidence: ReviewEvidence): ReviewWorkflowPlan {
    const provider = this.#providerForWorkflow(workflow);
    const recentEvidence = [...this.#recentEvidenceForHead(workflow.id, workflow.headSha), latestEvidence]
      .filter((value, index, values) => values.findIndex((other) => other.id === value.id) === index);
    const total = Number((this.database.db.prepare(`SELECT COUNT(*) AS count FROM review_workflow_evidence
      WHERE workflow_id = ? AND commit_sha = ?`).get(workflow.id, workflow.headSha) as Row).count);
    const providerInput = immutableJsonClone({ workflow, plan: current, recentEvidence,
      evidenceWindow: { limit: 100 as const, total, truncated: total > recentEvidence.length }, latestEvidence });
    const amendments = provider.revise(providerInput);
    return applyAmendments(current, amendments, workflow.enforcement);
  }

  #advance(workflow: ReviewWorkflow, plan: ReviewWorkflowPlan, cause: ReviewRevisionCause, now: string): void {
    const revision = workflow.currentRevision + 1;
    this.#insertRevision(workflow.id, revision, plan, cause, now);
    const changed = this.database.db.prepare(`UPDATE review_workflows
      SET current_revision = ?, updated_at = ? WHERE id = ? AND current_revision = ?`)
      .run(revision, now, workflow.id, workflow.currentRevision);
    if (changed.changes !== 1) throw new RuntimeError("conflict", "Review workflow changed concurrently");
  }

  #insertRevision(workflowId: string, revision: number, plan: ReviewWorkflowPlan,
    cause: ReviewRevisionCause, now: string): void {
    const normalized = validatePlan(plan);
    const planHash = hashCanonicalJson(normalized);
    this.database.db.prepare(`INSERT INTO review_workflow_revisions(
      workflow_id, revision, plan_json, plan_sha256, cause_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(workflowId, revision, JSON.stringify(normalized),
      planHash, JSON.stringify(cause), now);
    this.database.db.prepare(`INSERT INTO outbox(event_id, type, occurred_at, data_json)
      VALUES (?, ?, ?, ?)`).run(this.system.ids.next(), "review-workflow.revised", now,
      JSON.stringify({ workflowId, revision, planHash, cause }));
  }

  #insertEvidence(evidence: ReviewEvidence): void {
    this.database.db.prepare(`INSERT INTO review_workflow_evidence(
      id, workflow_id, recorded_revision, external_event_id, type, commit_sha, source_json, payload_json,
      assurance, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(evidence.id, evidence.workflowId, evidence.recordedRevision,
      evidence.externalEventId, evidence.type, evidence.commitSha, JSON.stringify(evidence.source), JSON.stringify(evidence.payload),
      evidence.assurance,
      evidence.createdAt);
  }

  #insertStageResult(result: ReviewStageResult): void {
    this.database.db.prepare(`INSERT INTO review_workflow_stage_results(
      id, workflow_id, recorded_revision, stage_id, stage_gate_sha256, commit_sha, evidence_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(result.id, result.workflowId, result.recordedRevision,
      result.stageId, result.stageGateHash, result.commitSha, result.evidenceId, result.createdAt);
  }

  #summary(workflow: ReviewWorkflow): ReviewWorkflowSummary {
    const current = this.#currentRevision(workflow.id);
    const stageResults = this.#stageResultsForPlan(workflow.id, workflow.headSha, current.plan);
    const stages = deriveStageStates(current.plan, workflow.headSha, stageResults);
    const evidence = this.#readinessEvidence(workflow, stages);
    return { workflow, current, stages, mergeReadiness: deriveMergeReadiness(workflow, stages, evidence),
      historyCounts: this.#historyCounts(workflow.id) };
  }

  #currentRevision(workflowId: string): ReviewWorkflowRevision {
    const row = this.database.db.prepare(`SELECT r.* FROM review_workflow_revisions r
      JOIN review_workflows w ON w.id = r.workflow_id AND w.current_revision = r.revision
      WHERE r.workflow_id = ?`).get(workflowId) as Row | undefined;
    if (!row) throw new RuntimeError("internal", `Review workflow current revision is missing: ${workflowId}`);
    return revisionFromRow(row);
  }

  #recentEvidenceForHead(workflowId: string, headSha: string): readonly ReviewEvidence[] {
    return (this.database.db.prepare(`SELECT * FROM review_workflow_evidence
      WHERE workflow_id = ? AND commit_sha = ? ORDER BY recorded_revision DESC, id DESC LIMIT 100`)
      .all(workflowId, headSha) as Row[]).reverse().map(evidenceFromRow);
  }

  #stageResultsForPlan(workflowId: string, headSha: string,
    plan: ReviewWorkflowPlan): readonly ReviewStageResult[] {
    const statement = this.database.db.prepare(`SELECT * FROM review_workflow_stage_results
      WHERE workflow_id = ? AND commit_sha = ? AND stage_id = ? AND stage_gate_sha256 = ?
      ORDER BY recorded_revision DESC, id DESC LIMIT 1`);
    return plan.stages.flatMap((stage) => {
      const row = statement.get(workflowId, headSha, stage.id, stageGateHash(plan, stage.id)) as Row | undefined;
      return row ? [stageResultFromRow(row)] : [];
    });
  }

  #readinessEvidence(workflow: ReviewWorkflow, stages: readonly ReviewStageState[]): readonly ReviewEvidence[] {
    const byId = new Map<string, ReviewEvidence>();
    const addRows = (rows: readonly Row[]) => {
      for (const row of rows) {
        const evidence = evidenceFromRow(row);
        byId.set(evidence.id, evidence);
      }
    };
    const stageEvidence = this.database.db.prepare("SELECT * FROM review_workflow_evidence WHERE id = ?");
    for (const state of stages) {
      if (!state.result) continue;
      const row = stageEvidence.get(state.result.evidenceId) as Row | undefined;
      if (row) addRows([row]);
    }
    const baselineEvidence = this.database.db.prepare(`SELECT * FROM review_workflow_evidence
      WHERE workflow_id = ? AND commit_sha = ? AND type = ? AND assurance = ?
        AND json_extract(source_json, '$.kind') = 'git-host' ORDER BY recorded_revision DESC, id DESC LIMIT 1`);
    for (const type of ["git.pull-request.opened", "git.base.protected"]) {
      for (const assurance of ["asserted", "attested"]) {
        const row = baselineEvidence.get(workflow.id, workflow.headSha, type, assurance) as Row | undefined;
        if (row) addRows([row]);
      }
    }
    const humanResults = stages.filter((state) => state.stage.required && state.stage.kind === "human-approval" &&
      state.result !== undefined).map((state) => state.result!);
    if (humanResults.length > 0) {
      const gateRevision = Math.max(...humanResults.map((result) => result.recordedRevision));
      addRows(this.database.db.prepare(`SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY source_json ORDER BY recorded_revision DESC, id DESC
        ) AS actor_rank FROM review_workflow_evidence
        WHERE workflow_id = ? AND commit_sha = ? AND type = 'review.human.approved'
          AND recorded_revision >= ? AND json_extract(source_json, '$.kind') = 'human'
      ) WHERE actor_rank = 1 ORDER BY recorded_revision DESC, id DESC LIMIT 20`)
        .all(workflow.id, workflow.headSha, gateRevision) as Row[]);
    }
    return [...byId.values()];
  }

  #historyCounts(workflowId: string): ReviewWorkflowSummary["historyCounts"] {
    const row = this.database.db.prepare(`SELECT
      (SELECT COUNT(*) FROM review_workflow_revisions WHERE workflow_id = ?) AS revisions,
      (SELECT COUNT(*) FROM review_workflow_evidence WHERE workflow_id = ?) AS evidence,
      (SELECT COUNT(*) FROM review_workflow_stage_results WHERE workflow_id = ?) AS stage_results`)
      .get(workflowId, workflowId, workflowId) as Row;
    return { revisions: Number(row.revisions), evidence: Number(row.evidence),
      stageResults: Number(row.stage_results) };
  }
}

export function deriveStageStates(plan: ReviewWorkflowPlan, headSha: string,
  results: readonly ReviewStageResult[]): readonly ReviewStageState[] {
  const completed = new Map<string, ReviewStageResult>();
  for (const stage of plan.stages) {
    const gateHash = stageGateHash(plan, stage.id);
    const result = [...results].reverse().find((value) => value.stageId === stage.id &&
      value.commitSha === headSha && value.stageGateHash === gateHash);
    if (result) completed.set(stage.id, result);
  }
  return plan.stages.map((stage) => {
    const result = completed.get(stage.id);
    const incompleteDependencies = stage.dependsOn.filter((dependency) => !completed.has(dependency));
    return { stage, state: result ? "completed" : incompleteDependencies.length > 0 ? "blocked" : "pending",
      incompleteDependencies, ...(result === undefined ? {} : { result }) };
  });
}

export function deriveMergeReadiness(workflow: ReviewWorkflow, stages: readonly ReviewStageState[],
  evidence: readonly ReviewEvidence[]): ReviewMergeReadiness {
  const blockers = stages.filter((state) => state.stage.required && state.state !== "completed")
    .map((state) => `Required stage is not complete: ${state.stage.id}`);
  const currentEvidence = evidence.filter((value) => value.commitSha === workflow.headSha);
  if (!currentEvidence.some((value) => value.type === "git.pull-request.opened" && value.source.kind === "git-host")) {
    blockers.push("No pull request evidence exists for the current head");
  }
  if (!currentEvidence.some((value) => value.type === "git.base.protected" && value.source.kind === "git-host")) {
    blockers.push("No protected base evidence exists for the current head");
  }
  const humanApprovals = new Set(currentEvidence.filter((value) =>
    value.type === "review.human.approved" && value.source.kind === "human")
    .map((value) => value.source.id)).size;
  if (humanApprovals < workflow.enforcement.minimumHumanApprovals) {
    blockers.push(`Human approvals ${humanApprovals}/${workflow.enforcement.minimumHumanApprovals}`);
  }
  const evidenceById = new Map(evidence.map((value) => [value.id, value]));
  const attestationBlockers = stages.filter((state) => state.stage.required && state.result !== undefined &&
    evidenceById.get(state.result.evidenceId)?.assurance !== "attested")
    .map((state) => `Stage evidence is operator-asserted: ${state.stage.id}`);
  if (!currentEvidence.some((value) => value.type === "git.pull-request.opened" &&
    value.source.kind === "git-host" && value.assurance === "attested")) {
    attestationBlockers.push("No attested pull request evidence exists for the current head");
  }
  if (!currentEvidence.some((value) => value.type === "git.base.protected" &&
    value.source.kind === "git-host" && value.assurance === "attested")) {
    attestationBlockers.push("No attested protected base evidence exists for the current head");
  }
  const attestedHumanApprovals = new Set(currentEvidence.filter((value) => value.type === "review.human.approved" &&
    value.source.kind === "human" && value.assurance === "attested").map((value) => value.source.id)).size;
  if (attestedHumanApprovals < workflow.enforcement.minimumHumanApprovals) {
    attestationBlockers.push(`Attested human approvals ${attestedHumanApprovals}/${workflow.enforcement.minimumHumanApprovals}`);
  }
  const ready = blockers.length === 0;
  const publishable = ready && attestationBlockers.length === 0;
  return { ready, publishable, assurance: publishable ? "attested" : "operator-asserted", blockers,
    attestationBlockers, humanApprovals };
}

export function stageGateHash(plan: ReviewWorkflowPlan, stageId: string): string {
  const stages = new Map(plan.stages.map((stage) => [stage.id, stage]));
  const memo = new Map<string, string>();
  const visit = (id: string): string => {
    const existing = memo.get(id);
    if (existing) return existing;
    const stage = stages.get(id);
    if (!stage) throw new RuntimeError("validation", `Unknown review stage dependency: ${id}`);
    const value = hashCanonicalJson({ stage, dependencies: stage.dependsOn.map((dependency) => visit(dependency)) });
    memo.set(id, value);
    return value;
  };
  return visit(stageId);
}

function applyAmendments(plan: ReviewWorkflowPlan, amendments: readonly ReviewWorkflowAmendment[],
  enforcement: ReviewEnforcement): ReviewWorkflowPlan {
  if (!Array.isArray(amendments)) {
    throw new RuntimeError("validation", "Review workflow provider amendments must be an array");
  }
  const stages: ReviewStage[] = plan.stages.map((stage) => ({ ...stage, dependsOn: [...stage.dependsOn] }));
  for (const amendment of amendments) {
    if (!amendment || typeof amendment !== "object" ||
      (amendment.type !== "add-stage" && amendment.type !== "add-dependency")) {
      throw new RuntimeError("validation", "Review workflow provider returned an unknown amendment");
    }
    if (amendment.type === "add-stage") {
      const stage = normalizeStage(amendment.stage);
      const existing = stages.find((value) => value.id === stage.id);
      if (existing && hashCanonicalJson(existing) !== hashCanonicalJson(stage)) {
        throw new RuntimeError("conflict", `Provider attempted to redefine review stage: ${stage.id}`);
      }
      if (!existing) stages.push(stage);
      continue;
    }
    const stageIndex = stages.findIndex((stage) => stage.id === amendment.stageId);
    if (stageIndex < 0) throw new RuntimeError("validation", `Provider amendment targets unknown stage: ${amendment.stageId}`);
    validateStageId(amendment.dependsOn);
    const stage = stages[stageIndex]!;
    if (!stage.dependsOn.includes(amendment.dependsOn)) {
      stages[stageIndex] = { ...stage, dependsOn: [...stage.dependsOn, amendment.dependsOn].sort(compareStrings) };
    }
  }
  return validatePlan({ stages }, enforcement);
}

function validatePlan(plan: ReviewWorkflowPlan, enforcement?: ReviewEnforcement): ReviewWorkflowPlan {
  if (!plan || !Array.isArray(plan.stages) || plan.stages.length < 1 || plan.stages.length > 100) {
    throw new RuntimeError("validation", "Review workflow plan must have from 1 through 100 stages");
  }
  const stages = plan.stages.map(normalizeStage);
  const ids = new Set<string>();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new RuntimeError("validation", `Duplicate review stage: ${stage.id}`);
    ids.add(stage.id);
  }
  for (const stage of stages) {
    for (const dependency of stage.dependsOn) {
      if (!ids.has(dependency)) throw new RuntimeError("validation", `Unknown dependency ${dependency} for ${stage.id}`);
      if (dependency === stage.id) throw new RuntimeError("validation", `Review stage depends on itself: ${stage.id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new RuntimeError("validation", `Review workflow contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const stage of stages) visit(stage.id);
  if (enforcement) {
    requireBaselineStage(stages, "protected-base", "protected base verification",
      "git.base.protected", "git-host");
    const pullRequestStages = requireBaselineStage(stages, "pull-request", "pull request",
      "git.pull-request.opened", "git-host");
    const humanStages = requireBaselineStage(stages, "human-approval", "human approval",
      "review.human.approved", "human");
    const pullRequestIds = new Set(pullRequestStages.map((stage) => stage.id));
    if (humanStages.some((stage) => !dependsOnAny(stage.id, pullRequestIds, byId))) {
      throw new RuntimeError("validation", "Every required human approval stage must depend on a required pull request stage");
    }
  }
  return { stages };
}

function requireBaselineStage(stages: readonly ReviewStage[], kind: ReviewStageKind, label: string,
  evidenceType: string, sourceKind: ReviewEvidenceSourceKind): readonly ReviewStage[] {
  const matches = stages.filter((stage) => stage.kind === kind && stage.required);
  if (matches.length === 0) {
    throw new RuntimeError("validation", `Review workflow must include a required ${label} stage`);
  }
  if (matches.some((stage) => stage.evidence.type !== evidenceType ||
    !stage.evidence.acceptedSourceKinds.includes(sourceKind))) {
    throw new RuntimeError("validation", `Required ${label} stages must accept ${evidenceType} from ${sourceKind}`);
  }
  return matches;
}

function dependsOnAny(stageId: string, targets: ReadonlySet<string>, stages: ReadonlyMap<string, ReviewStage>): boolean {
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    visited.add(id);
    return stages.get(id)!.dependsOn.some((dependency) => targets.has(dependency) || visit(dependency));
  };
  return visit(stageId);
}

function normalizeStage(stage: ReviewStage): ReviewStage {
  if (!stage || typeof stage !== "object") throw new RuntimeError("validation", "Review stage must be an object");
  validateStageId(stage.id);
  validateIdentifier(stage.label, `Review stage label for ${stage.id}`, 160);
  if (!stageKinds.has(stage.kind)) throw new RuntimeError("validation", `Unknown review stage kind: ${String(stage.kind)}`);
  if (typeof stage.required !== "boolean") throw new RuntimeError("validation", `Review stage required must be boolean: ${stage.id}`);
  if (!Array.isArray(stage.dependsOn)) throw new RuntimeError("validation", `Review stage dependencies must be an array: ${stage.id}`);
  const dependsOn = [...new Set(stage.dependsOn.map((dependency) => {
    validateStageId(dependency); return dependency;
  }))].sort(compareStrings);
  const evidence = normalizeEvidenceRequirement(stage.evidence, stage.id);
  return { id: stage.id, label: stage.label.trim(), kind: stage.kind, required: stage.required, dependsOn, evidence };
}

const stageKinds = new Set<ReviewStageKind>([
  "protected-base", "implementation", "pull-request", "automated-check", "agent-review", "human-approval", "custom",
]);

function configuredStage(value: unknown, index: number): ReviewStage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError("validation", `Declarative review stage ${index} must be an object`);
  }
  const stage = value as Partial<ReviewStage>;
  return normalizeStage({ id: String(stage.id ?? ""), label: String(stage.label ?? ""),
    kind: String(stage.kind ?? "") as ReviewStageKind, required: stage.required as boolean,
    dependsOn: stage.dependsOn as readonly string[], evidence: stage.evidence as ReviewEvidenceRequirement });
}

function normalizeEvidenceRequirement(value: ReviewEvidenceRequirement, stageId: string): ReviewEvidenceRequirement {
  if (!value || typeof value !== "object") {
    throw new RuntimeError("validation", `Review stage evidence requirement must be an object: ${stageId}`);
  }
  validateIdentifier(value.type, `Review stage evidence type for ${stageId}`, 120);
  if (!Array.isArray(value.acceptedSourceKinds) || value.acceptedSourceKinds.length < 1) {
    throw new RuntimeError("validation", `Review stage must accept at least one evidence source kind: ${stageId}`);
  }
  const acceptedSourceKinds = [...new Set(value.acceptedSourceKinds.map((kind) => {
    if (!sourceKinds.has(kind)) throw new RuntimeError("validation", `Invalid evidence source kind for ${stageId}: ${kind}`);
    return kind;
  }))].sort(compareStrings);
  let requiredPayloadFields: readonly string[] | undefined;
  if (value.requiredPayloadFields !== undefined) {
    if (!Array.isArray(value.requiredPayloadFields)) {
      throw new RuntimeError("validation", `Required evidence payload fields must be an array: ${stageId}`);
    }
    requiredPayloadFields = [...new Set(value.requiredPayloadFields.map((field) => {
      validateIdentifier(field, `Required evidence payload field for ${stageId}`, 120); return field.trim();
    }))].sort(compareStrings);
  }
  return { type: value.type.trim(), acceptedSourceKinds,
    ...(requiredPayloadFields === undefined || requiredPayloadFields.length === 0 ? {} : { requiredPayloadFields }) };
}

function validateCreateInput(input: CreateReviewWorkflowInput): {
  readonly projectId: string; readonly repository: string; readonly baseBranch: string; readonly headSha: string;
  readonly minimumHumanApprovals: number; readonly providerId: string; readonly providerVersion?: string;
  readonly configuration: JsonObject;
} {
  if (!input || typeof input !== "object") throw new RuntimeError("validation", "Review workflow input must be an object");
  validateIdentifier(input.projectId, "Project id", 120);
  validateIdentifier(input.repository, "Repository", 240);
  validateIdentifier(input.baseBranch, "Base branch", 240);
  validateHeadSha(input.headSha);
  const minimumHumanApprovals = input.minimumHumanApprovals ?? 1;
  if (!Number.isSafeInteger(minimumHumanApprovals) || minimumHumanApprovals < 1 || minimumHumanApprovals > 20) {
    throw new RuntimeError("validation", "Minimum human approvals must be an integer from 1 through 20");
  }
  if (input.provider !== undefined && (!input.provider || typeof input.provider !== "object" || Array.isArray(input.provider))) {
    throw new RuntimeError("validation", "Review workflow provider selection must be an object");
  }
  const providerId = input.provider?.id ?? "core.review.adaptive";
  validateIdentifier(providerId, "Review workflow provider id", 120);
  const providerVersion = input.provider?.version;
  if (providerVersion !== undefined) validateIdentifier(providerVersion, "Review workflow provider version", 40);
  const configuration = input.provider?.configuration ?? {};
  validateJsonObject(configuration, "Review workflow provider configuration");
  return { projectId: input.projectId.trim(), repository: input.repository.trim(), baseBranch: input.baseBranch.trim(),
    headSha: input.headSha.toLowerCase(), minimumHumanApprovals, providerId: providerId.trim(),
    ...(providerVersion === undefined ? {} : { providerVersion: providerVersion.trim() }),
    configuration: immutableJsonClone(configuration) };
}

function validateEvidenceInput(input: ReviewEvidenceInput, headSha: string): void {
  validateEvidenceShape(input);
  if (input.commitSha.toLowerCase() !== headSha) {
    throw new RuntimeError("conflict", "Review evidence must target the workflow current head", { headSha });
  }
}

function validateEvidenceShape(input: ReviewEvidenceInput): void {
  if (!input || typeof input !== "object") throw new RuntimeError("validation", "Review evidence must be an object");
  validateExternalEventId(input.externalEventId);
  validateIdentifier(input.type, "Review evidence type", 120);
  validateHeadSha(input.commitSha);
  validateEvidenceSource(input.source);
  validateJsonObject(input.payload ?? {}, "Review evidence payload");
}

function validateEvidenceSource(source: ReviewEvidenceSource): void {
  if (!source || typeof source !== "object" || !sourceKinds.has(source.kind)) {
    throw new RuntimeError("validation", "Review evidence source kind is invalid");
  }
  validateIdentifier(source.id, "Review evidence source id", 160);
}

function assertEvidenceReplay(existing: ReviewEvidence, input: ReviewEvidenceInput): void {
  const expected = { externalEventId: input.externalEventId.trim(), type: input.type.trim(),
    commitSha: input.commitSha.toLowerCase(), source: { kind: input.source.kind, id: input.source.id.trim() },
    payload: input.payload ?? {} };
  const actual = { externalEventId: existing.externalEventId, type: existing.type, commitSha: existing.commitSha,
    source: existing.source, payload: existing.payload };
  if (hashCanonicalJson(expected) !== hashCanonicalJson(actual)) {
    throw new RuntimeError("conflict", "External event id is already used by different evidence");
  }
}

const sourceKinds = new Set<ReviewEvidenceSource["kind"]>(["agent", "tool", "ci", "human", "git-host", "system"]);

function validateStageEvidence(stage: ReviewStage, evidence: ReviewEvidence): void {
  if (evidence.type !== stage.evidence.type) {
    throw new RuntimeError("validation", `Review stage ${stage.id} requires evidence type ${stage.evidence.type}`);
  }
  if (!stage.evidence.acceptedSourceKinds.includes(evidence.source.kind)) {
    throw new RuntimeError("validation", `Review stage ${stage.id} does not accept source kind ${evidence.source.kind}`);
  }
  for (const field of stage.evidence.requiredPayloadFields ?? []) {
    if (!Object.hasOwn(evidence.payload, field)) {
      throw new RuntimeError("validation", `Review stage ${stage.id} requires evidence payload field ${field}`);
    }
  }
}

function assertExpectedRevision(workflow: ReviewWorkflow, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new RuntimeError("validation", "Expected revision must be a positive integer");
  }
  if (workflow.currentRevision !== expectedRevision) {
    throw new RuntimeError("conflict", "Review workflow revision does not match", {
      expectedRevision, currentRevision: workflow.currentRevision,
    });
  }
}

function validateStageId(value: string): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._:-]{0,79}$/.test(value)) {
    throw new RuntimeError("validation", `Invalid review stage id: ${String(value)}`);
  }
}

function validateIdentifier(value: string, label: string, maximumLength: number): void {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maximumLength || /[\u0000-\u001f]/.test(value)) {
    throw new RuntimeError("validation", `${label} must be a non-empty string of at most ${maximumLength} characters`);
  }
}

function validateHeadSha(value: string): void {
  if (typeof value !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value)) {
    throw new RuntimeError("validation", "Head SHA must be a full 40-character SHA-1 or 64-character SHA-256 object id");
  }
}

function validateExternalEventId(value: string): void {
  validateIdentifier(value, "External evidence event id", 200);
}

function validateJsonObject(value: JsonObject, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError("validation", `${label} must be a JSON object`);
  }
  try {
    const canonical = canonicalJson(value);
    if (Buffer.byteLength(canonical, "utf8") > 64 * 1024) {
      throw new RuntimeError("validation", `${label} must not exceed 64 KiB`);
    }
  }
  catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError("validation", `${label} must contain canonical JSON values`);
  }
}

function stageSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!slug) throw new RuntimeError("validation", "Risk category must contain an ASCII letter or number");
  return slug;
}

function workflowFromRow(row: Row): ReviewWorkflow {
  return { id: String(row.id), projectId: String(row.project_id), repository: String(row.repository),
    baseBranch: String(row.base_branch), headSha: String(row.head_sha),
    enforcement: JSON.parse(String(row.enforcement_json)) as ReviewEnforcement,
    provider: { id: String(row.provider_id), version: String(row.provider_version) },
    providerConfiguration: JSON.parse(String(row.provider_configuration_json)) as JsonObject,
    currentRevision: Number(row.current_revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function revisionFromRow(row: Row): ReviewWorkflowRevision {
  const plan = JSON.parse(String(row.plan_json)) as ReviewWorkflowPlan;
  const planHash = String(row.plan_sha256);
  if (hashCanonicalJson(plan) !== planHash) {
    throw new RuntimeError("internal", `Review workflow revision hash mismatch: ${row.workflow_id}@${row.revision}`);
  }
  return { workflowId: String(row.workflow_id), revision: Number(row.revision), plan, planHash,
    cause: JSON.parse(String(row.cause_json)) as ReviewRevisionCause, createdAt: String(row.created_at) };
}

function evidenceFromRow(row: Row): ReviewEvidence {
  return { id: String(row.id), workflowId: String(row.workflow_id), recordedRevision: Number(row.recorded_revision),
    externalEventId: String(row.external_event_id),
    type: String(row.type), commitSha: String(row.commit_sha),
    source: JSON.parse(String(row.source_json)) as ReviewEvidenceSource,
    payload: JSON.parse(String(row.payload_json)) as JsonObject,
    assurance: String(row.assurance) as ReviewEvidence["assurance"], createdAt: String(row.created_at) };
}

function stageResultFromRow(row: Row): ReviewStageResult {
  return { id: String(row.id), workflowId: String(row.workflow_id), recordedRevision: Number(row.recorded_revision),
    stageId: String(row.stage_id), stageGateHash: String(row.stage_gate_sha256), commitSha: String(row.commit_sha),
    evidenceId: String(row.evidence_id), createdAt: String(row.created_at) };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerKey(id: string, version: string): string { return JSON.stringify([id, version]); }

function providerLabel(identity: ComponentIdentity): string { return `${identity.id}@${identity.version}`; }

function immutableJsonClone<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
