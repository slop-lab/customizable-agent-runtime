import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KernelDatabase,
  defaultReviewWorkflowPlan,
  deriveMergeReadiness,
  ReviewWorkflowService,
  Runtime,
  RuntimeError,
  ToolDispatcher,
} from "../dist/index.js";

const head = "a".repeat(40);
const nextHead = "b".repeat(40);
let externalEvent = 0;

function deterministicSystem(prefix = "review") {
  let id = 0;
  let tick = 0;
  return {
    ids: { next: () => `${prefix}-${++id}` },
    clock: { now: () => `2026-08-24T00:00:${String(tick++).padStart(2, "0")}.000Z` },
  };
}

function evidence(type, commitSha, kind, id, payload = {}) {
  return { externalEventId: `test-event-${++externalEvent}`, type, commitSha, source: { kind, id }, payload };
}

async function complete(service, snapshot, stageId, stageEvidence) {
  return service.completeStage(snapshot.workflow.id, {
    expectedRevision: snapshot.workflow.currentRevision,
    stageId,
    evidence: stageEvidence,
  });
}

test("adaptive workflows append risk review revisions and only become ready after ordered current-head evidence", async () => {
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem());
  let snapshot = await service.create({ projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head });
  assert.equal(snapshot.workflow.currentRevision, 1);
  assert.deepEqual(snapshot.current.cause, { kind: "created" });
  assert.equal(snapshot.mergeReadiness.ready, false);
  assert.deepEqual(snapshot.stages.filter((stage) => stage.state === "pending").map((stage) => stage.stage.id),
    ["base-protection", "implementation"]);

  snapshot = await complete(service, snapshot, "base-protection",
    evidence("git.base.protected", head, "git-host", "gitea"));
  snapshot = await complete(service, snapshot, "implementation",
    evidence("implementation.completed", head, "agent", "implementer"));
  snapshot = await complete(service, snapshot, "pull-request",
    evidence("git.pull-request.opened", head, "git-host", "gitea", { number: 17 }));
  snapshot = await complete(service, snapshot, "automated-checks",
    evidence("check.passed", head, "ci", "verify"));
  assert.equal(snapshot.stages.find((stage) => stage.stage.id === "code-review").state, "pending");

  const staleRevision = snapshot.workflow.currentRevision;
  snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
    evidence("risk.detected", head, "tool", "diff-classifier", { category: "security" }));
  assert.equal(snapshot.workflow.currentRevision, staleRevision + 1);
  assert.equal(snapshot.current.cause.kind, "evidence-recorded");
  assert.equal(snapshot.current.plan.stages.some((stage) => stage.id === "security-review"), true);
  assert.deepEqual(snapshot.current.plan.stages.find((stage) => stage.id === "code-review").dependsOn,
    ["automated-checks", "security-review"]);
  assert.equal(snapshot.stages.find((stage) => stage.stage.id === "code-review").state, "blocked");
  await assert.rejects(
    () => complete(service, snapshot, "code-review", evidence("review.agent.approved", head, "agent", "reviewer")),
    (error) => error instanceof RuntimeError && error.code === "conflict" &&
      error.details.incompleteDependencies.includes("security-review"),
  );

  snapshot = await complete(service, snapshot, "security-review",
    evidence("review.agent.approved", head, "agent", "security-reviewer"));
  snapshot = await complete(service, snapshot, "code-review",
    evidence("review.agent.approved", head, "agent", "code-reviewer"));
  snapshot = await complete(service, snapshot, "human-approval",
    evidence("review.human.approved", head, "human", "alice"));
  assert.equal(snapshot.mergeReadiness.ready, true);
  assert.equal(snapshot.mergeReadiness.publishable, false);
  assert.equal(snapshot.mergeReadiness.assurance, "operator-asserted");
  assert.equal(snapshot.mergeReadiness.humanApprovals, 1);
  assert.equal(snapshot.historyCounts.revisions, snapshot.workflow.currentRevision);
  assert.equal(snapshot.historyCounts.evidence, 8);

  snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
    evidence("review.human.approved", head, "agent", "not-a-human"));
  assert.equal(snapshot.mergeReadiness.humanApprovals, 1);
  assert.equal(snapshot.mergeReadiness.ready, true);

  await assert.rejects(
    () => service.appendEvidence(snapshot.workflow.id, staleRevision,
      evidence("check.passed", head, "ci", "late-writer")),
    (error) => error instanceof RuntimeError && error.code === "conflict" &&
      error.details.currentRevision === snapshot.workflow.currentRevision,
  );

  snapshot = await service.updateHead(snapshot.workflow.id, { expectedRevision: snapshot.workflow.currentRevision,
    headSha: nextHead, externalEventId: `test-event-${++externalEvent}`, source: { kind: "human", id: "alice" } });
  assert.equal(snapshot.workflow.headSha, nextHead);
  assert.equal(snapshot.current.cause.kind, "head-changed");
  assert.equal(snapshot.mergeReadiness.ready, false);
  assert.equal(snapshot.stages.every((stage) => stage.state !== "completed"), true);
  assert.match(snapshot.mergeReadiness.blockers.join("\n"), /No pull request evidence/);
  database.close();
});

test("a late adaptive dependency invalidates only its transitive downstream completions", async () => {
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem("late"));
  let snapshot = await service.create({ projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head });
  snapshot = await complete(service, snapshot, "base-protection",
    evidence("git.base.protected", head, "git-host", "gitea"));
  snapshot = await complete(service, snapshot, "implementation",
    evidence("implementation.completed", head, "agent", "implementer"));
  snapshot = await complete(service, snapshot, "pull-request",
    evidence("git.pull-request.opened", head, "git-host", "gitea"));
  snapshot = await complete(service, snapshot, "automated-checks",
    evidence("check.passed", head, "ci", "verify"));
  snapshot = await complete(service, snapshot, "code-review",
    evidence("review.agent.approved", head, "agent", "reviewer"));
  snapshot = await complete(service, snapshot, "human-approval",
    evidence("review.human.approved", head, "human", "alice"));
  assert.equal(snapshot.mergeReadiness.ready, true);

  snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
    evidence("risk.detected", head, "tool", "late-classifier", { category: "security" }));
  const states = Object.fromEntries(snapshot.stages.map((stage) => [stage.stage.id, stage.state]));
  assert.equal(states["base-protection"], "completed");
  assert.equal(states.implementation, "completed");
  assert.equal(states["pull-request"], "completed");
  assert.equal(states["automated-checks"], "completed");
  assert.equal(states["security-review"], "pending");
  assert.equal(states["code-review"], "blocked");
  assert.equal(states["human-approval"], "blocked");
  assert.equal(snapshot.mergeReadiness.ready, false);
  database.close();
});

test("distinct risk categories cannot collide after stage-id normalization", async () => {
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem("risk-id"));
  let snapshot = await service.create({ projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head });
  snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
    evidence("risk.detected", head, "tool", "classifier", { category: "foo bar" }));
  snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
    evidence("risk.detected", head, "tool", "classifier", { category: "foo-bar" }));
  const riskStages = snapshot.current.plan.stages.filter((stage) => stage.id.startsWith("risk-review-"));
  assert.equal(riskStages.length, 2);
  assert.notEqual(riskStages[0].id, riskStages[1].id);
  database.close();
});

test("provider inputs are frozen and provider versions coexist for durable workflows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "car-review-provider-"));
  const path = join(directory, "runtime.sqlite");
  const mutationAttempts = [];
  const provider = (version) => ({ identity: { id: "integration.policy.review", version },
    create(input) {
      assert.throws(() => { input.enforcement.minimumHumanApprovals = 0; }, TypeError);
      assert.throws(() => { input.configuration.changed = true; }, TypeError);
      mutationAttempts.push(`create:${version}`);
      return defaultReviewWorkflowPlan();
    },
    revise(input) {
      assert.throws(() => { input.plan.stages[0].required = false; }, TypeError);
      assert.throws(() => { input.workflow.enforcement.minimumHumanApprovals = 0; }, TypeError);
      mutationAttempts.push(`revise:${version}`);
      return [];
    } });
  let database = new KernelDatabase(path);
  let service = new ReviewWorkflowService(database, deterministicSystem("provider"), [provider("1"), provider("2")]);
  await assert.rejects(() => service.create({ projectId: "ambiguous", repository: "dim/car", baseBranch: "main",
    headSha: head, provider: { id: "integration.policy.review" } }), /version is required/);
  let first = await service.create({ projectId: "v1", repository: "dim/car", baseBranch: "main", headSha: head,
    minimumHumanApprovals: 2, provider: { id: "integration.policy.review", version: "1", configuration: { safe: true } } });
  let second = await service.create({ projectId: "v2", repository: "dim/car", baseBranch: "main", headSha: head,
    provider: { id: "integration.policy.review", version: "2" } });
  assert.equal(first.workflow.enforcement.minimumHumanApprovals, 2);
  database.close();

  database = new KernelDatabase(path);
  service = new ReviewWorkflowService(database, deterministicSystem("provider-restart"), [provider("1"), provider("2")]);
  first = await service.appendEvidence(first.workflow.id, first.workflow.currentRevision,
    evidence("note.recorded", head, "human", "operator"));
  second = await service.appendEvidence(second.workflow.id, second.workflow.currentRevision,
    evidence("note.recorded", head, "human", "operator"));
  assert.equal(first.workflow.provider.version, "1");
  assert.equal(second.workflow.provider.version, "2");
  assert.deepEqual(mutationAttempts, ["create:1", "create:2", "revise:1", "revise:2"]);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("external evidence event ids make mutation retries idempotent", async () => {
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem("idempotent"));
  let snapshot = await service.create({ projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head });
  const completionEvidence = evidence("implementation.completed", head, "agent", "implementer");
  const completed = await service.completeStage(snapshot.workflow.id, { expectedRevision: 1,
    stageId: "implementation", evidence: completionEvidence });
  const replay = await service.completeStage(snapshot.workflow.id, { expectedRevision: 1,
    stageId: "implementation", evidence: completionEvidence });
  assert.equal(replay.workflow.currentRevision, completed.workflow.currentRevision);
  assert.equal(replay.historyCounts.evidence, 1);
  assert.equal(replay.historyCounts.stageResults, 1);
  await assert.rejects(() => service.appendEvidence(snapshot.workflow.id, 1,
    { ...completionEvidence, type: "different.event" }), /already used by different evidence/);

  const headEventId = `test-event-${++externalEvent}`;
  snapshot = await service.updateHead(snapshot.workflow.id, { expectedRevision: completed.workflow.currentRevision,
    headSha: nextHead, externalEventId: headEventId, source: { kind: "human", id: "operator" } });
  const headReplay = await service.updateHead(snapshot.workflow.id, { expectedRevision: completed.workflow.currentRevision,
    headSha: nextHead, externalEventId: headEventId, source: { kind: "human", id: "operator" } });
  assert.equal(headReplay.workflow.currentRevision, snapshot.workflow.currentRevision);
  assert.equal(headReplay.historyCounts.evidence, 2);
  database.close();
});

test("runtime close drains queued review workflow creation and stage completion", async () => {
  const provider = { id: "unused", profile: { id: "unused", provider: "fake", model: "unused",
    endpoint: "fake://unused", credentialHandle: "none" }, capabilities: { version: 1, values: {} },
    async invoke() { throw new Error("unused"); } };
  const driver = { id: "unused", version: "1", async run() {} };

  for (const operation of ["create", "complete"]) {
    const database = new KernelDatabase(":memory:");
    const runtime = new Runtime(provider, driver, new ToolDispatcher([]), { database });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    let snapshot;
    if (operation === "complete") {
      snapshot = await runtime.createReviewWorkflow({ projectId: "car", repository: "dim/car",
        baseBranch: "main", headSha: head });
    }
    let release;
    const blocker = database.writer.run(() => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    const mutation = operation === "create"
      ? runtime.createReviewWorkflow({ projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head })
      : runtime.completeReviewStage(snapshot.workflow.id, { expectedRevision: snapshot.workflow.currentRevision,
        stageId: "implementation", evidence: evidence("implementation.completed", head, "agent", "implementer") });
    const closing = runtime.close();
    release();
    await blocker;
    const result = await mutation;
    await closing;
    assert.equal(operation === "create" ? result.workflow.currentRevision :
      result.stages.find((stage) => stage.stage.id === "implementation").state, operation === "create" ? 1 : "completed");
    assert.equal(events.some((event) => event.type === "review-workflow.revised"), true);
  }
});

test("declarative provider accepts strengthened DAGs and rejects weakened or cyclic plans", async () => {
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem("declarative"));
  const required = [
    { id: "base", label: "Base", kind: "protected-base", required: true, dependsOn: [],
      evidence: { type: "git.base.protected", acceptedSourceKinds: ["git-host"] } },
    { id: "implementation", label: "Implementation", kind: "implementation", required: true, dependsOn: [],
      evidence: { type: "implementation.completed", acceptedSourceKinds: ["agent"] } },
    { id: "pull", label: "PR", kind: "pull-request", required: true, dependsOn: ["implementation"],
      evidence: { type: "git.pull-request.opened", acceptedSourceKinds: ["git-host"] } },
    { id: "approval", label: "Approval", kind: "human-approval", required: true, dependsOn: ["base", "pull"],
      evidence: { type: "review.human.approved", acceptedSourceKinds: ["human"] } },
  ];
  const snapshot = await service.create({ projectId: "custom", repository: "dim/custom", baseBranch: "stable",
    headSha: head, minimumHumanApprovals: 2,
    provider: { id: "core.review.declarative", configuration: { stages: required } } });
  assert.equal(snapshot.workflow.enforcement.minimumHumanApprovals, 2);
  assert.deepEqual(snapshot.current.plan.stages.map((stage) => stage.id), ["base", "implementation", "pull", "approval"]);

  await assert.rejects(
    () => service.create({ projectId: "weak", repository: "dim/weak", baseBranch: "main", headSha: head,
      provider: { id: "core.review.declarative", configuration: { stages: required.filter((stage) => stage.id !== "approval") } } }),
    (error) => error instanceof RuntimeError && error.code === "validation" && /human approval/.test(error.message),
  );
  const cyclic = required.map((stage) => stage.id === "implementation" ? { ...stage, dependsOn: ["pull"] } : stage);
  await assert.rejects(
    () => service.create({ projectId: "cycle", repository: "dim/cycle", baseBranch: "main", headSha: head,
      provider: { id: "core.review.declarative", configuration: { stages: cyclic } } }),
    (error) => error instanceof RuntimeError && error.code === "validation" && /cycle/.test(error.message),
  );
  await assert.rejects(() => service.create({ projectId: "short", repository: "dim/short", baseBranch: "main",
    headSha: "abcdef0" }), /full 40-character SHA-1 or 64-character SHA-256/);
  const sha256 = await service.create({ projectId: "sha256", repository: "dim/sha256", baseBranch: "main",
    headSha: "c".repeat(64) });
  assert.equal(sha256.workflow.headSha.length, 64);
  database.close();
});

test("revision reads detect stored plan hash corruption", async () => {
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem("integrity"));
  const snapshot = await service.create({ projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head });
  database.db.exec("DROP TRIGGER review_workflow_revisions_immutable");
  database.db.prepare("UPDATE review_workflow_revisions SET plan_sha256 = 'corrupt' WHERE workflow_id = ?")
    .run(snapshot.workflow.id);
  assert.throws(() => service.get(snapshot.workflow.id), /revision hash mismatch/);
  database.close();
});

test("workflow revisions, evidence, and stage history survive restart and are immutable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "car-review-workflow-"));
  const path = join(directory, "runtime.sqlite");
  let database = new KernelDatabase(path);
  let service = new ReviewWorkflowService(database, deterministicSystem("persist"));
  let snapshot = await service.create({ projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head });
  snapshot = await complete(service, snapshot, "implementation",
    evidence("implementation.completed", head, "agent", "implementer"));
  const workflowId = snapshot.workflow.id;
  assert.throws(() => database.db.prepare(`UPDATE review_workflow_revisions SET plan_sha256 = 'changed'
    WHERE workflow_id = ? AND revision = 1`).run(workflowId), /review workflow revisions are immutable/);
  assert.throws(() => database.db.prepare(`UPDATE review_workflow_evidence SET type = 'changed'
    WHERE workflow_id = ?`).run(workflowId), /review workflow evidence is immutable/);
  assert.throws(() => database.db.prepare(`UPDATE review_workflow_stage_results SET stage_id = 'changed'
    WHERE workflow_id = ?`).run(workflowId), /review workflow stage results are immutable/);
  assert.throws(() => database.db.prepare(`UPDATE review_workflows SET enforcement_json = '{}'
    WHERE id = ?`).run(workflowId), /identity and enforcement are immutable/);
  assert.throws(() => database.db.prepare(`DELETE FROM review_workflow_evidence
    WHERE workflow_id = ?`).run(workflowId), /append-only/);
  database.close();

  database = new KernelDatabase(path);
  service = new ReviewWorkflowService(database, deterministicSystem("unused"));
  snapshot = service.get(workflowId);
  assert.equal(snapshot.workflow.currentRevision, 2);
  assert.deepEqual(snapshot.historyCounts, { revisions: 2, evidence: 1, stageResults: 1 });
  const history = service.history(workflowId, { limit: 1 });
  assert.equal(history.revisions.length, 1);
  assert.equal(history.nextBeforeRevision, 2);
  const older = service.history(workflowId, { limit: 1, beforeRevision: history.nextBeforeRevision });
  assert.deepEqual(older.revisions.map((revision) => revision.revision), [1]);
  assert.equal(older.nextBeforeRevision, undefined);
  assert.equal(snapshot.stages.find((stage) => stage.stage.id === "implementation").state, "completed");
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("provider identities are tuple-keyed and evidence windows are explicit and bounded", async () => {
  const observations = [];
  const providers = [
    { identity: { id: "a@b", version: "c" }, create: () => defaultReviewWorkflowPlan(), revise: () => [] },
    { identity: { id: "a", version: "b@c" }, create: () => defaultReviewWorkflowPlan(),
      revise(input) { observations.push(input); return []; } },
  ];
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem("tuple"), providers);
  let snapshot = await service.create({ projectId: "tuple", repository: "dim/car", baseBranch: "main", headSha: head,
    provider: { id: "a", version: "b@c" } });
  assert.deepEqual(snapshot.workflow.provider, { id: "a", version: "b@c" });
  for (let index = 0; index < 101; index += 1) {
    snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
      evidence("note.recorded", head, "tool", `note-${index}`));
  }
  const latest = observations.at(-1);
  assert.deepEqual(latest.evidenceWindow, { limit: 100, total: 101, truncated: true });
  assert.equal(latest.recentEvidence.length, 100);
  assert.equal(latest.recentEvidence.at(-1).source.id, "note-100");
  assert.deepEqual(snapshot.historyCounts, { revisions: 102, evidence: 101, stageResults: 0 });
  assert.equal(service.history(snapshot.workflow.id, { limit: 100 }).revisions.length, 100);
  database.close();
});

test("required payload fields must be own properties", async () => {
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem("own-field"));
  const stages = defaultReviewWorkflowPlan().stages.map((stage) => stage.id === "implementation"
    ? { ...stage, evidence: { ...stage.evidence, requiredPayloadFields: ["toString"] } } : stage);
  const snapshot = await service.create({ projectId: "payload", repository: "dim/car", baseBranch: "main", headSha: head,
    provider: { id: "core.review.declarative", configuration: { stages } } });
  await assert.rejects(() => complete(service, snapshot, "implementation",
    evidence("implementation.completed", head, "agent", "implementer")), /requires evidence payload field toString/);
  const completed = await complete(service, snapshot, "implementation",
    evidence("implementation.completed", head, "agent", "implementer", { toString: "verified" }));
  assert.equal(completed.stages.find((stage) => stage.stage.id === "implementation").state, "completed");
  database.close();
});

test("late plan amendments invalidate approvals that predate the current human gate", async () => {
  const database = new KernelDatabase(":memory:");
  const service = new ReviewWorkflowService(database, deterministicSystem("approval-gate"));
  let snapshot = await service.create({ projectId: "approval", repository: "dim/car", baseBranch: "main", headSha: head,
    minimumHumanApprovals: 2 });
  for (const [stageId, stageEvidence] of [
    ["base-protection", evidence("git.base.protected", head, "git-host", "gitea")],
    ["implementation", evidence("implementation.completed", head, "agent", "implementer")],
    ["pull-request", evidence("git.pull-request.opened", head, "git-host", "gitea")],
    ["automated-checks", evidence("check.passed", head, "ci", "verify")],
    ["code-review", evidence("review.agent.approved", head, "agent", "reviewer")],
    ["human-approval", evidence("review.human.approved", head, "human", "alice")],
  ]) snapshot = await complete(service, snapshot, stageId, stageEvidence);
  snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
    evidence("review.human.approved", head, "human", "bob"));
  assert.equal(snapshot.mergeReadiness.ready, true);
  for (let index = 0; index < 21; index += 1) {
    snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
      evidence("review.human.approved", head, "agent", `noise-${index}`));
  }
  assert.equal(snapshot.mergeReadiness.humanApprovals, 2);
  assert.equal(snapshot.mergeReadiness.ready, true);

  snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
    evidence("risk.detected", head, "tool", "classifier", { category: "security" }));
  snapshot = await complete(service, snapshot, "security-review",
    evidence("review.agent.approved", head, "agent", "security"));
  snapshot = await complete(service, snapshot, "code-review",
    evidence("review.agent.approved", head, "agent", "reviewer-2"));
  snapshot = await complete(service, snapshot, "human-approval",
    evidence("review.human.approved", head, "human", "alice"));
  assert.equal(snapshot.mergeReadiness.humanApprovals, 1);
  assert.equal(snapshot.mergeReadiness.ready, false);
  snapshot = await service.appendEvidence(snapshot.workflow.id, snapshot.workflow.currentRevision,
    evidence("review.human.approved", head, "human", "carol"));
  assert.equal(snapshot.mergeReadiness.humanApprovals, 2);
  assert.equal(snapshot.mergeReadiness.ready, true);
  database.close();
});

test("publishable readiness requires attested git-host baseline claims", () => {
  const plan = defaultReviewWorkflowPlan();
  const workflow = { id: "workflow", projectId: "car", repository: "dim/car", baseBranch: "main", headSha: head,
    enforcement: { pullRequestRequired: true, protectedBaseRequired: true, minimumHumanApprovals: 1,
      invalidateOnHeadChange: true }, provider: { id: "test", version: "1" }, providerConfiguration: {},
    currentRevision: 7, createdAt: "now", updatedAt: "now" };
  const evidenceRows = plan.stages.map((stage, index) => ({ id: `e-${index}`, workflowId: workflow.id,
    recordedRevision: index + 2, externalEventId: `event-${index}`, type: stage.evidence.type, commitSha: head,
    source: { kind: stage.kind === "human-approval" ? "human" : stage.kind === "protected-base" ||
      stage.kind === "pull-request" ? "agent" : stage.evidence.acceptedSourceKinds[0], id: `source-${index}` },
    payload: {}, assurance: "attested", createdAt: "now" }));
  evidenceRows.push({ ...evidenceRows[0], id: "asserted-base", externalEventId: "asserted-base",
    source: { kind: "git-host", id: "gitea" }, assurance: "asserted" });
  evidenceRows.push({ ...evidenceRows[2], id: "asserted-pr", externalEventId: "asserted-pr",
    source: { kind: "git-host", id: "gitea" }, assurance: "asserted" });
  const stages = plan.stages.map((stage, index) => ({ stage, state: "completed", incompleteDependencies: [],
    result: { id: `r-${index}`, workflowId: workflow.id, recordedRevision: index + 2, stageId: stage.id,
      stageGateHash: "gate", commitSha: head, evidenceId: `e-${index}`, createdAt: "now" } }));
  const readiness = deriveMergeReadiness(workflow, stages, evidenceRows);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.publishable, false);
  assert.match(readiness.attestationBlockers.join("\n"), /No attested pull request evidence/);
  assert.match(readiness.attestationBlockers.join("\n"), /No attested protected base evidence/);
});
