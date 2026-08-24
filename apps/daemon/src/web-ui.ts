export const webUiHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CAR</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; grid-template-columns: 18rem minmax(0, 1fr) 24rem; }
    aside, main { min-width: 0; padding: 1rem; }
    aside { border-inline-end: 1px solid #7776; overflow: auto; }
    aside:last-child { border-inline: 1px solid #7776; border-inline-end: 0; }
    header { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
    button, textarea { font: inherit; }
    button { cursor: pointer; padding: .4rem .7rem; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    textarea { width: 100%; min-height: 7rem; resize: vertical; padding: .65rem; }
    form { display: grid; gap: .5rem; }
    .row { display: flex; gap: .5rem; align-items: center; }
    .list { display: grid; gap: .4rem; }
    .list button { width: 100%; text-align: start; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selected { outline: 2px solid #4f8cff; }
    #records { display: grid; gap: .65rem; margin-bottom: 1rem; }
    .record { border: 1px solid #7776; border-radius: .4rem; padding: .65rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user { border-inline-start: .35rem solid #4f8cff; }
    .assistant { border-inline-start: .35rem solid #42a66c; }
    .error { border-inline-start: .35rem solid #d85858; }
    summary { cursor: pointer; font-weight: 600; }
    pre { margin: .5rem 0 0; padding: .6rem; overflow: auto; background: #7772; white-space: pre-wrap; overflow-wrap: anywhere; }
    .muted { opacity: .7; font-size: .9rem; }
    #status { margin-inline-start: auto; }
    h1, h2 { margin-top: 0; }
    @media (max-width: 960px) {
      body { grid-template-columns: 14rem minmax(0, 1fr); }
      aside:last-child { grid-column: 1 / -1; border-top: 1px solid #7776; }
    }
  </style>
</head>
<body>
  <aside>
    <header><h2>Sessions</h2><button id="newSession" type="button">New</button></header>
    <div id="sessions" class="list"></div>
    <h2 style="margin-top:1.5rem">Runs</h2>
    <div id="runs" class="list"></div>
  </aside>
  <main>
    <header>
      <h1>CAR</h1>
      <span id="status" class="muted">Loading…</span>
      <button id="cancelRun" type="button" disabled>Cancel run</button>
    </header>
    <div id="records"></div>
    <form id="promptForm">
      <textarea id="prompt" required placeholder="Ask the agent to inspect or change the workspace"></textarea>
      <div class="row"><button id="send" type="submit">Run</button><span class="muted">Ctrl/Cmd+Enter to send</span></div>
    </form>
  </main>
  <aside>
    <h2>Runtime</h2>
    <pre id="runtime">Loading…</pre>
    <h2 style="margin-top:1.5rem">Inspector</h2>
    <pre id="inspector">Select a run.</pre>
  </aside>
  <script>
    const state = { sessionId: undefined, activeRunId: undefined, selectedRunId: undefined, polling: false };
    const elements = Object.fromEntries(["sessions", "runs", "records", "status", "cancelRun", "promptForm",
      "prompt", "send", "newSession", "runtime", "inspector"].map((id) => [id, document.getElementById(id)]));

    async function api(path, options) {
      const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options && options.headers) } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || ("HTTP " + response.status));
      return body;
    }

    function button(label, onClick, selected) {
      const value = document.createElement("button");
      value.type = "button";
      value.textContent = label;
      if (selected) value.className = "selected";
      value.addEventListener("click", onClick);
      return value;
    }

    function json(value) { return JSON.stringify(value, null, 2); }

    async function loadRuntime() {
      const [capabilities, plugins] = await Promise.all([api("/v1/capabilities"), api("/v1/plugins")]);
      elements.runtime.textContent = json({ provider: capabilities.provider.profile,
        driver: capabilities.driver, tools: capabilities.tools.map((tool) => tool.name), plugins });
    }

    async function loadSessions(preferredId) {
      let sessions = await api("/v1/sessions?limit=100");
      if (sessions.length === 0) {
        const created = await api("/v1/sessions", { method: "POST", body: "{}" });
        sessions = await api("/v1/sessions?limit=100");
        preferredId = created.id;
      }
      const nextId = preferredId || state.sessionId || sessions[0].id;
      elements.sessions.replaceChildren(...sessions.map((session) => button(
        session.firstUserMessage || session.id,
        () => selectSession(session.id),
        session.id === nextId,
      )));
      if (state.sessionId !== nextId) await selectSession(nextId, false);
    }

    async function selectSession(sessionId, reloadSessions = true) {
      state.sessionId = sessionId;
      state.activeRunId = undefined;
      state.selectedRunId = undefined;
      elements.cancelRun.disabled = true;
      if (reloadSessions) await loadSessions(sessionId);
      await refreshConversation();
    }

    function renderRecords(records) {
      const nodes = records.map((record) => {
        const data = record.data || {};
        if (record.kind === "tool-call" || record.kind === "tool-result") {
          const details = document.createElement("details");
          details.className = "record";
          const summary = document.createElement("summary");
          summary.textContent = record.kind === "tool-call"
            ? "Tool call: " + (data.toolName || "unknown")
            : "Tool result: " + (data.callId || "unknown") + (data.isError ? " (error)" : "");
          const pre = document.createElement("pre");
          pre.textContent = json(data);
          details.append(summary, pre);
          return details;
        }
        const article = document.createElement("article");
        article.className = "record " + record.kind;
        article.textContent = typeof data.text === "string" ? data.text : json(data);
        return article;
      });
      elements.records.replaceChildren(...nodes);
    }

    async function refreshConversation() {
      if (!state.sessionId) return;
      const [records, runs] = await Promise.all([
        api("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/records"),
        api("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/runs?limit=100"),
      ]);
      renderRecords(records);
      elements.runs.replaceChildren(...runs.map((run) => button(
        run.status + " · " + run.id,
        () => inspectRun(run.id),
        run.id === state.selectedRunId,
      )));
      const running = runs.find((run) => run.status === "running");
      if (running) state.activeRunId = running.id;
      elements.cancelRun.disabled = !state.activeRunId;
      elements.status.textContent = state.activeRunId ? "Run in progress" : "Ready";
      elements.send.disabled = Boolean(state.activeRunId);
    }

    async function inspectRun(runId) {
      state.selectedRunId = runId;
      const [run, attempts, operations, provenance] = await Promise.all([
        api("/v1/runs/" + encodeURIComponent(runId)),
        api("/v1/runs/" + encodeURIComponent(runId) + "/attempts"),
        api("/v1/runs/" + encodeURIComponent(runId) + "/operations"),
        api("/v1/runs/" + encodeURIComponent(runId) + "/provenance"),
      ]);
      let context;
      if (attempts.length > 0) context = await api("/v1/context-projections/" +
        encodeURIComponent(attempts[attempts.length - 1].contextProjectionId));
      elements.inspector.textContent = json({ run, attempts, operations, provenance, context });
      await refreshConversation();
    }

    async function startRun(input) {
      const run = await api("/v1/sessions/" + encodeURIComponent(state.sessionId) + "/runs", {
        method: "POST", body: JSON.stringify({ input }),
      });
      state.activeRunId = run.id;
      state.selectedRunId = run.id;
      elements.prompt.value = "";
      await refreshConversation();
      poll();
    }

    async function poll() {
      if (state.polling) return;
      state.polling = true;
      try {
        while (state.activeRunId) {
          const run = await api("/v1/runs/" + encodeURIComponent(state.activeRunId));
          await refreshConversation();
          if (run.status !== "running") {
            state.activeRunId = undefined;
            await inspectRun(run.id);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) { elements.status.textContent = error.message; }
      finally { state.polling = false; await refreshConversation(); }
    }

    elements.promptForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = elements.prompt.value.trim();
      if (!input || state.activeRunId) return;
      try { await startRun(input); } catch (error) { elements.status.textContent = error.message; }
    });
    elements.prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) elements.promptForm.requestSubmit();
    });
    elements.newSession.addEventListener("click", async () => {
      try {
        const session = await api("/v1/sessions", { method: "POST", body: "{}" });
        await loadSessions(session.id);
      } catch (error) { elements.status.textContent = error.message; }
    });
    elements.cancelRun.addEventListener("click", async () => {
      if (!state.activeRunId) return;
      try { await api("/v1/runs/" + encodeURIComponent(state.activeRunId) + "/cancel", { method: "POST", body: "{}" }); }
      catch (error) { elements.status.textContent = error.message; }
    });

    Promise.all([loadRuntime(), loadSessions()]).then(() => poll()).catch((error) => {
      elements.status.textContent = error.message;
    });
  </script>
</body>
</html>`;
