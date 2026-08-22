import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecutionWorker, WorkerRequest, WorkerResponse, WorkspaceHandle } from "@car/core";
import { ArtifactIngressStore } from "@car/core";

const execFileAsync = promisify(execFile);

export interface LocalWorkerOptions {
  readonly workspace: WorkspaceHandle;
  readonly root: string;
  readonly maxOutputBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly artifactIngress?: ArtifactIngressStore;
  readonly environment?: Readonly<Record<string, string>>;
}

export class LocalDevelopmentWorker implements ExecutionWorker {
  readonly identity = { id: "defaults.worker.local-development", version: "1" } as const;
  readonly #root: Promise<string>;
  readonly #maxOutputBytes: number;
  readonly #maxArtifactBytes: number;
  readonly #environment: Readonly<Record<string, string>>;

  constructor(private readonly options: LocalWorkerOptions) {
    this.#root = realpath(options.root);
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? 16 * 1024 * 1024;
    this.#environment = options.environment ?? { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" };
  }

  async execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResponse> {
    if (request.workspace !== this.options.workspace) return failure("invalid-scope", "Unknown workspace capability");
    if (signal.aborted) return failure("cancelled", "Operation was cancelled");
    const remaining = Date.parse(request.deadline) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return failure("timeout", "Worker deadline elapsed");
    try {
      if (request.type === "readFile") {
        const path = await this.#resolve(request.path, request.cwd);
        const output = await readFile(path, "utf8");
        return this.#output(request, output);
      }
      if (request.type === "list") {
        const path = await this.#resolve(request.path, request.cwd);
        const entries = await readdir(path, { withFileTypes: true });
        const output = entries.sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n");
        return this.#output(request, output, { entries: entries.length });
      }
      if (request.type === "search") {
        const cwd = await this.#resolve(".", request.cwd);
        const path = await this.#resolve(request.path ?? ".", request.cwd);
        try {
          const result = await execFileAsync("rg", ["--line-number", "--with-filename", "--color=never", "--no-heading",
            "--", request.query, relative(cwd, path) || "."], {
            cwd, env: this.#environment, signal, timeout: remaining, maxBuffer: this.#maxArtifactBytes,
          });
          const output = `${result.stdout}${result.stderr}`;
          return this.#output(request, output, { matches: lineCount(result.stdout) });
        } catch (error) {
          const value = error as { code?: string | number };
          if (value.code === 1) return { ok: true, output: "", metadata: { matches: 0 } };
          throw error;
        }
      }
      if (request.type === "writeFile") {
        const root = await this.#root;
        const path = await this.#resolveWritable(request.path, request.cwd);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, request.content, { encoding: "utf8", signal });
        return { ok: true, output: `Wrote ${relative(root, path) || "."}`,
          metadata: { bytes: Buffer.byteLength(request.content) } };
      }
      if (request.type === "applyPatch") {
        const cwd = await this.#resolve(".", request.cwd);
        const temporary = await mkdtemp(join(tmpdir(), "car-worker-patch-"));
        const patchPath = join(temporary, "change.diff");
        try {
          await writeFile(patchPath, request.patch, { encoding: "utf8", signal });
          const result = await execFileAsync("git", ["apply", "--whitespace=nowarn", patchPath], {
            cwd, env: this.#environment, signal, timeout: remaining, maxBuffer: this.#maxArtifactBytes,
          });
          return { ok: true, output: `${result.stdout}${result.stderr}` || "Applied patch" };
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      if (request.type === "gitStatus") {
        const cwd = await this.#resolve(".", request.cwd);
        const result = await execFileAsync("git", ["status", "--short", "--branch"], {
          cwd, env: this.#environment, signal, timeout: remaining, maxBuffer: this.#maxArtifactBytes,
        });
        return this.#output(request, `${result.stdout}${result.stderr}`);
      }
      const cwd = await this.#resolve(".", request.cwd);
      const result = await execFileAsync("/bin/sh", ["-lc", request.command], {
        cwd, env: this.#environment, signal, timeout: remaining, maxBuffer: this.#maxArtifactBytes,
      });
      return this.#output(request, `${result.stdout}${result.stderr}`);
    } catch (error) {
      const uncertain = isSideEffecting(request);
      if (signal.aborted) return failure("cancelled", "Operation was cancelled", uncertain);
      const value = error as { code?: string | number; killed?: boolean; message?: string; stdout?: string; stderr?: string };
      if (value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return failure("output-limit", "Worker output exceeds limit", uncertain);
      if (value.killed) return failure("timeout", "Shell operation timed out", true);
      if (value.code === "CAR_INVALID_SCOPE") return failure("invalid-scope", value.message ?? "Path is outside workspace");
      return failure("worker-failed", value.message ?? String(error), uncertain);
    }
  }

  #output(request: WorkerRequest, output: string,
    metadata?: Readonly<Record<string, unknown>>): WorkerResponse {
    const bytes = Buffer.byteLength(output);
    if (bytes <= this.#maxOutputBytes) return { ok: true, output,
      ...(metadata === undefined ? {} : { metadata }) };
    if (bytes > this.#maxArtifactBytes || this.options.artifactIngress === undefined) {
      return failure("output-limit", `Worker output exceeds ${this.#maxArtifactBytes} bytes`, isSideEffecting(request));
    }
    const artifact = this.options.artifactIngress.stageText(request.operationId, output);
    return { ok: true, output: projectOutput(output, this.#maxOutputBytes), artifact,
      ...(metadata === undefined ? {} : { metadata }) };
  }

  async #resolve(path: string, cwd = "."): Promise<string> {
    const root = await this.#root;
    if (isAbsolute(path) || isAbsolute(cwd)) throw scopeError("Absolute paths are not allowed");
    const unresolved = resolve(root, cwd, path);
    assertWithinRoot(root, unresolved);
    const candidate = await realpath(unresolved);
    assertWithinRoot(root, candidate);
    return candidate;
  }

  async #resolveWritable(path: string, cwd = "."): Promise<string> {
    const root = await this.#root;
    if (isAbsolute(path) || isAbsolute(cwd)) throw scopeError("Absolute paths are not allowed");
    const unresolved = resolve(root, cwd, path);
    assertWithinRoot(root, unresolved);
    let ancestor = unresolved;
    while (true) {
      try {
        const resolvedAncestor = await realpath(ancestor);
        assertWithinRoot(root, resolvedAncestor);
        const candidate = resolve(resolvedAncestor, relative(ancestor, unresolved));
        assertWithinRoot(root, candidate);
        return candidate;
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
}

function assertWithinRoot(root: string, candidate: string): void {
    const fromRoot = relative(root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
      throw scopeError("Path is outside workspace");
    }
}

function failure(code: Extract<WorkerResponse, { ok: false }>["code"], message: string,
  uncertain = false): WorkerResponse {
  return { ok: false, code, message, ...(uncertain ? { uncertain: true } : {}) };
}
function scopeError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "CAR_INVALID_SCOPE" });
}
function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}
function isSideEffecting(request: WorkerRequest): boolean {
  return request.type === "writeFile" || request.type === "applyPatch" || request.type === "shell";
}

function projectOutput(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  const marker = Buffer.from(`\n... ${bytes.byteLength} bytes total; middle omitted ...\n`);
  if (maximumBytes <= marker.byteLength) return marker.subarray(0, maximumBytes).toString("utf8");
  const available = maximumBytes - marker.byteLength;
  const headBytes = Math.floor(available * 0.65);
  return Buffer.concat([bytes.subarray(0, headBytes), marker,
    bytes.subarray(bytes.byteLength - (available - headBytes))]).toString("utf8");
}
