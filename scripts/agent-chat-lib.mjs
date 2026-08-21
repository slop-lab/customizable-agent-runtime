export async function runAgentChat({ runtime, terminal, output, dataDirectory, initialSessionId }) {
  let session;
  if (initialSessionId !== undefined) {
    session = runtime.getSession(initialSessionId);
    if (!session) throw new Error(`Unknown session: ${initialSessionId}`);
  } else session = await runtime.createSession();
  const lines = [];
  let activeExecution; let cancellationRequested = false;
  const onInterrupt = () => {
    if (activeExecution) {
      if (!cancellationRequested) {
        cancellationRequested = true;
        output.write(`\n[cancelling run ${activeExecution.run.id}]\n`);
        activeExecution.cancel();
      } else output.write("\n[cancellation already requested; waiting for durable terminal state]\n");
      return;
    }
    output.write("\n"); terminal.close();
  };
  terminal.on?.("SIGINT", onInterrupt);
  output.write(`CAR interactive agent\nsession: ${session.id}\ndata: ${dataDirectory}\n` +
    "Compose one or more lines, then type /send. Type /help for commands.\n\n");
  terminal.setPrompt("you> "); prompt(terminal);
  try { for await (const line of terminal) {
    const command = line.trim();
    if (command === "/exit" || command === "/quit") break;
    if (command === "/help") {
      output.write("/send                 send the composed prompt\n/show                 preview it\n" +
        "/cancel               discard it\n/sessions [limit]     list durable sessions\n" +
        "/runs [session-id]   list runs\n/resume <session-id> select an existing session\n" +
        "/new                  create and select a session\n/id                   show the current session ID\n" +
        "/exit                 quit\n\n");
      prompt(terminal); continue;
    }
    if (command === "/id") { output.write(`${session.id}\n\n`); prompt(terminal); continue; }
    if (command === "/sessions" || command.startsWith("/sessions ")) {
      const limit = parseLimit(command.slice("/sessions".length).trim());
      if (limit === undefined) output.write("[usage: /sessions [1-100]]\n\n");
      else printSessions(output, runtime.listSessions({ limit }), session.id);
      prompt(terminal); continue;
    }
    if (command === "/runs" || command.startsWith("/runs ")) {
      const id = command.slice("/runs".length).trim() || session.id;
      if (!runtime.getSession(id)) output.write(`[unknown session: ${id}]\n\n`);
      else printRuns(output, runtime.listRuns(id));
      prompt(terminal); continue;
    }
    if (command === "/resume" || command.startsWith("/resume ")) {
      const id = command.slice("/resume".length).trim();
      if (lines.length > 0) output.write("[discard or send the pending prompt before changing sessions]\n\n");
      else if (!id) output.write("[usage: /resume <session-id>]\n\n");
      else {
        const selected = runtime.getSession(id);
        if (!selected) output.write(`[unknown session: ${id}]\n\n`);
        else { session = selected; output.write(`[resumed session ${session.id}]\n\n`); }
      }
      prompt(terminal); continue;
    }
    if (command === "/new") {
      if (lines.length > 0) output.write("[discard or send the pending prompt before changing sessions]\n\n");
      else { session = await runtime.createSession(); output.write(`[new session ${session.id}]\n\n`); }
      prompt(terminal); continue;
    }
    if (command === "/show") {
      output.write(lines.length === 0 ? "[prompt is empty]\n\n" : `${lines.join("\n")}\n[${summary(lines)}]\n\n`);
      prompt(terminal); continue;
    }
    if (command === "/cancel") {
      lines.length = 0; terminal.setPrompt("you> "); output.write("[prompt discarded]\n\n"); prompt(terminal); continue;
    }
    if (command !== "/send") {
      lines.push(line); terminal.setPrompt("...> "); prompt(terminal); continue;
    }
    if (lines.length === 0) { output.write("[prompt is empty]\n\n"); prompt(terminal); continue; }

    const input = lines.join("\n"); output.write(`[sending ${summary(lines)}]\n`);
    lines.length = 0; terminal.setPrompt("you> ");
    const before = runtime.getRecords(session.id).length;
    activeExecution = await runtime.startRun(session.id, input); cancellationRequested = false;
    let run;
    try { run = await activeExecution.completion; }
    finally { activeExecution = undefined; cancellationRequested = false; }
    const records = runtime.getRecords(session.id).slice(before + 1);
    for (const record of records) {
      const data = record.data ?? {};
      if (record.kind === "tool-call") output.write(`[tool] ${data.toolName} ${JSON.stringify(data.input)}\n`);
      else if (record.kind === "tool-result" && data.isError) output.write(`[tool error] ${format(data.output)}\n`);
      else if (record.kind === "assistant") output.write(`agent> ${data.text}\n`);
      else if (record.kind === "error") output.write(`[run error] ${data.message}\n`);
    }
    const attempts = runtime.getModelAttempts(run.id);
    const retries = attempts.filter((attempt) => attempt.retryOfAttemptId !== undefined).length;
    output.write(`[run ${run.status}: ${run.id}; model requests=${attempts.length}; retries=${retries}]\n\n`);
    prompt(terminal);
  } } finally { terminal.off?.("SIGINT", onInterrupt); }
}

function printSessions(output, sessions, selectedId) {
  if (sessions.length === 0) { output.write("[no sessions]\n\n"); return; }
  output.write("sessions (newest first)\n");
  for (const session of sessions) {
    const marker = session.id === selectedId ? "*" : " "; const preview = session.firstUserMessage ?? "(empty)";
    output.write(`${marker} ${session.id}  ${session.updatedAt}  runs=${session.runCount} ` +
      `${formatRunCounts(session.runStatusCounts)}  ${preview}\n`);
  }
  output.write("\n");
}
function printRuns(output, runs) {
  if (runs.length === 0) { output.write("[no runs]\n\n"); return; }
  output.write("runs (newest first)\n");
  for (const run of runs) output.write(`- ${run.id}  ${run.status}  ${run.startedAt} ` +
    `requests=${run.modelRequestCount} retries=${run.retryCount} tools=${run.toolOperationCount}\n`);
  output.write("\n");
}
function formatRunCounts(counts) {
  return Object.entries(counts).filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`).join(" ") || "no-runs";
}
function parseLimit(value) {
  if (value === "") return 20;
  if (!/^\d+$/.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : undefined;
}
function prompt(terminal) { if (!terminal.closed) terminal.prompt(); }
function summary(lines) { return `${lines.length} line${lines.length === 1 ? "" : "s"}, ${lines.join("\n").length} chars`; }
function format(value) { return typeof value === "string" ? value : JSON.stringify(value); }
