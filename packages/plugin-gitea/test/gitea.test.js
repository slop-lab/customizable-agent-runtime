import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost, ToolDispatcher } from "@car/core";
import { createGiteaPlugin, GiteaFetchTransport } from "../dist/index.js";

const context = { sessionId: "session", runId: "run", operationId: "operation", workspace: "workspace",
  deadline: new Date(Date.now() + 5_000).toISOString(), signal: new AbortController().signal };

test("Gitea plugin exposes namespaced read-only tools with bounded projections", async () => {
  const paths = [];
  const transport = { async request(path) {
    paths.push(path);
    if (path.includes("/pulls/")) return { number: 7, title: "Ready", state: "open", draft: false,
      mergeable: true, base: { ref: "main" }, head: { ref: "feature" }, html_url: "https://gitea.test/pr/7",
      user: { login: "dim" }, updated_at: "2026-08-22T00:00:00Z", body: "must not be projected" };
    return { name: "c".repeat(400), full_name: "dim/car", description: "x".repeat(700), private: true,
      archived: false, default_branch: "main", html_url: "https://gitea.test/dim/car",
      updated_at: "2026-08-22T00:00:00Z", open_issues_count: 3, clone_url: "must not be projected" };
  } };
  const host = await PluginHost.initialize([createGiteaPlugin({ baseUrl: "https://gitea.test/",
    credentialHandle: "env:GITEA_TOKEN", transport })]);
  const dispatcher = new ToolDispatcher(host.tools(), host.middleware());
  const repository = JSON.parse((await dispatcher.dispatch("integration.gitea.repository.get",
    { owner: "dim org", repository: "car" }, context)).output);
  assert.equal(repository.description.length, 500);
  assert.equal(repository.name.length, 255);
  assert.equal("clone_url" in repository, false);
  const pull = JSON.parse((await dispatcher.dispatch("integration.gitea.pull.get",
    { owner: "dim org", repository: "car", index: 7 }, context)).output);
  assert.deepEqual(pull, { index: 7, title: "Ready", state: "open", draft: false, mergeable: true,
    base: "main", head: "feature", url: "https://gitea.test/pr/7", author: "dim",
    updatedAt: "2026-08-22T00:00:00Z" });
  assert.deepEqual(paths, ["/repos/dim%20org/car", "/repos/dim%20org/car/pulls/7"]);
  assert.deepEqual(host.identities(), [{ id: "integration.gitea", version: "1", dependencies: [],
    configuration: { baseUrl: "https://gitea.test", credentialHandle: "env:GITEA_TOKEN" } }]);
  host.close();
});

test("Gitea fetch transport resolves credentials only at request time", async () => {
  let resolved = 0; let observedUrl; let observedAuthorization;
  const credentials = { resolve(handle) { resolved++; assert.equal(handle, "env:GITEA_TOKEN"); return "secret-token"; } };
  const transport = new GiteaFetchTransport("https://gitea.test/subpath/", "env:GITEA_TOKEN", credentials,
    async (url, init) => {
      observedUrl = String(url); observedAuthorization = new Headers(init.headers).get("authorization");
      return new Response(JSON.stringify({ version: "1.23" }), { status: 200 });
    });
  assert.equal(resolved, 0);
  assert.deepEqual(await transport.request("/version", new AbortController().signal), { version: "1.23" });
  assert.equal(resolved, 1);
  assert.equal(observedUrl, "https://gitea.test/subpath/api/v1/version");
  assert.equal(observedAuthorization, "token secret-token");
});

test("Gitea transport rejects unsafe configuration and classifies HTTP errors", async () => {
  assert.throws(() => new GiteaFetchTransport("file:///tmp/gitea", "env:TOKEN", { resolve() { return "x"; } }),
    /HTTP or HTTPS|HTTP\(S\)/);
  const transport = new GiteaFetchTransport("https://gitea.test", "env:TOKEN", { resolve() { return "x"; } },
    async () => new Response("not found", { status: 404 }));
  await assert.rejects(() => transport.request("/repos/dim/missing", new AbortController().signal),
    (error) => error.code === "not-found" && !error.message.includes("not found"));
  await assert.rejects(() => transport.request("https://evil.test", new AbortController().signal),
    (error) => error.code === "validation");
  await assert.rejects(() => transport.request("/repos/../admin", new AbortController().signal),
    (error) => error.code === "validation");
});

test("Gitea tools reject oversized, traversal-shaped, and additional input", async () => {
  const host = await PluginHost.initialize([createGiteaPlugin({ baseUrl: "https://gitea.test",
    credentialHandle: "env:TOKEN", transport: { async request() { throw new Error("must not execute"); } } })]);
  const dispatcher = new ToolDispatcher(host.tools());
  await assert.rejects(() => dispatcher.dispatch("integration.gitea.repository.get",
    { owner: "..", repository: "car" }, context), (error) => error.code === "validation");
  await assert.rejects(() => dispatcher.dispatch("integration.gitea.repository.get",
    { owner: "x".repeat(256), repository: "car" }, context), (error) => error.code === "validation");
  await assert.rejects(() => dispatcher.dispatch("integration.gitea.pull.get",
    { owner: "dim", repository: "car", index: 1, extra: true }, context),
  (error) => error.code === "validation");
  host.close();
});
