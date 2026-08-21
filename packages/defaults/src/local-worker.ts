import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecutionWorker, WorkerRequest, WorkerResponse, WorkspaceHandle } from "@car/core";

const execFileAsync = promisify(execFile);

export interface LocalWorkerOptions {
  readonly workspace: WorkspaceHandle;
  readonly root: string;
  readonly maxOutputBytes?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

export class LocalDevelopmentWorker implements ExecutionWorker {
  readonly #root: Promise<string>;
  readonly #maxOutputBytes: number;
  readonly #environment: Readonly<Record<string, string>>;

  constructor(private readonly options: LocalWorkerOptions) {
    this.#root = realpath(options.root);
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
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
        if (Buffer.byteLength(output) > this.#maxOutputBytes) return failure("output-limit", "File exceeds worker output limit");
        return { ok: true, output };
      }
      const cwd = await this.#resolve(".", request.cwd);
      const result = await execFileAsync("/bin/sh", ["-lc", request.command], {
        cwd, env: this.#environment, signal, timeout: remaining, maxBuffer: this.#maxOutputBytes,
      });
      return { ok: true, output: `${result.stdout}${result.stderr}` };
    } catch (error) {
      if (signal.aborted) return failure("cancelled", "Operation was cancelled");
      const value = error as { code?: string | number; killed?: boolean; message?: string; stdout?: string; stderr?: string };
      if (value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return failure("output-limit", "Shell output exceeds worker limit", true);
      if (value.killed) return failure("timeout", "Shell operation timed out", true);
      if (value.code === "CAR_INVALID_SCOPE") return failure("invalid-scope", value.message ?? "Path is outside workspace");
      return failure("worker-failed", value.message ?? String(error), request.type === "shell");
    }
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
