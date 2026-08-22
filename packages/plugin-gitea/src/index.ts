import type { RuntimePlugin, Tool } from "@car/core";
import { RuntimeError } from "@car/core";

export interface CredentialResolver {
  resolve(handle: string): string;
}

export interface GiteaTransport {
  request(path: string, signal: AbortSignal): Promise<unknown>;
}

export class GiteaFetchTransport implements GiteaTransport {
  readonly #baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly credentialHandle: string,
    private readonly credentials: CredentialResolver,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    if (!nonEmpty(credentialHandle)) throw new RuntimeError("validation", "Gitea credential handle must not be empty");
  }

  async request(path: string, signal: AbortSignal): Promise<unknown> {
    if (!path.startsWith("/") || path.includes("?") || path.includes("#") || /\/\.{1,2}(?:\/|$)/.test(path)) {
      throw new RuntimeError("validation", "Gitea API path must be an absolute path without a query or fragment");
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.#baseUrl}/api/v1${path}`, {
        method: "GET",
        signal,
        headers: { accept: "application/json", authorization: `token ${this.credentials.resolve(this.credentialHandle)}` },
      });
    } catch (error) {
      if (signal.aborted) throw new RuntimeError("cancelled", "Gitea request cancelled");
      throw new RuntimeError("internal", `Gitea request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new RuntimeError(response.status === 404 ? "not-found" : "internal",
        `Gitea request failed with HTTP ${response.status}`, { status: response.status });
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 1024 * 1024) {
      throw new RuntimeError("internal", "Gitea response exceeded 1 MiB");
    }
    const body = await response.text();
    if (Buffer.byteLength(body) > 1024 * 1024) throw new RuntimeError("internal", "Gitea response exceeded 1 MiB");
    try { return JSON.parse(body) as unknown; }
    catch { throw new RuntimeError("internal", "Gitea returned invalid JSON"); }
  }
}

export interface GiteaPluginOptions {
  readonly baseUrl: string;
  readonly credentialHandle: string;
  readonly transport: GiteaTransport;
}

export function createGiteaPlugin(options: GiteaPluginOptions): RuntimePlugin {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!nonEmpty(options.credentialHandle)) {
    throw new RuntimeError("validation", "Gitea credential handle must not be empty");
  }
  return {
    manifest: { apiVersion: 1, id: "integration.gitea", version: "1",
      configuration: { baseUrl, credentialHandle: options.credentialHandle } },
    setup(registrar) {
      registrar.registerTool(repositoryTool(options.transport));
      registrar.registerTool(pullRequestTool(options.transport));
    },
    async health(signal) {
      await options.transport.request("/version", signal);
      return { status: "ready" };
    },
  };
}

function repositoryTool(transport: GiteaTransport): Tool {
  return {
    description: {
      name: "integration.gitea.repository.get",
      version: "1",
      description: "Get bounded metadata for one Gitea repository.",
      inputSchema: repositorySchema(),
      validateInput: (input) => isRepositoryInput(input)
        ? undefined : "Expected an object with non-empty owner and repository strings.",
    },
    async execute(input, context) {
      const value = input as RepositoryInput;
      const result = objectValue(await transport.request(
        `/repos/${pathSegment(value.owner)}/${pathSegment(value.repository)}`, context.signal));
      return { output: JSON.stringify(compact({
        name: boundedString(result.name, 255),
        fullName: boundedString(result.full_name, 511),
        description: boundedString(result.description, 500),
        private: booleanValue(result.private),
        archived: booleanValue(result.archived),
        defaultBranch: boundedString(result.default_branch, 255),
        url: boundedString(result.html_url, 2_048),
        updatedAt: boundedString(result.updated_at, 64),
        openIssues: nonNegativeInteger(result.open_issues_count),
      })) };
    },
  };
}

function pullRequestTool(transport: GiteaTransport): Tool {
  return {
    description: {
      name: "integration.gitea.pull.get",
      version: "1",
      description: "Get bounded metadata for one Gitea pull request.",
      inputSchema: { ...repositorySchema(), properties: { ...repositorySchema().properties,
        index: { type: "integer", minimum: 1 } }, required: ["owner", "repository", "index"] },
      validateInput: (input) => isPullRequestInput(input)
        ? undefined : "Expected owner and repository strings plus a positive integer index.",
    },
    async execute(input, context) {
      const value = input as PullRequestInput;
      const result = objectValue(await transport.request(
        `/repos/${pathSegment(value.owner)}/${pathSegment(value.repository)}/pulls/${value.index}`, context.signal));
      const base = objectValue(result.base); const head = objectValue(result.head); const user = objectValue(result.user);
      return { output: JSON.stringify(compact({
        index: positiveInteger(result.number),
        title: boundedString(result.title, 500),
        state: boundedString(result.state, 32),
        draft: booleanValue(result.draft),
        mergeable: booleanValue(result.mergeable),
        base: boundedString(base.ref, 255),
        head: boundedString(head.ref, 255),
        url: boundedString(result.html_url, 2_048),
        author: boundedString(user.login, 255),
        updatedAt: boundedString(result.updated_at, 64),
      })) };
    },
  };
}

interface RepositoryInput { readonly owner: string; readonly repository: string }
interface PullRequestInput extends RepositoryInput { readonly index: number }

function isRepositoryInput(value: unknown): value is RepositoryInput {
  const object = objectValue(value);
  return segmentString(object.owner) && segmentString(object.repository) && hasOnlyKeys(object, ["owner", "repository"]);
}
function isPullRequestInput(value: unknown): value is PullRequestInput {
  const object = objectValue(value);
  return segmentString(object.owner) && segmentString(object.repository) && typeof object.index === "number" &&
    Number.isSafeInteger(object.index) && object.index > 0 && hasOnlyKeys(object, ["owner", "repository", "index"]);
}
function repositorySchema() {
  return { type: "object", properties: { owner: { type: "string", minLength: 1, maxLength: 255 },
    repository: { type: "string", minLength: 1, maxLength: 255 } },
    required: ["owner", "repository"], additionalProperties: false } as const;
}
function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new RuntimeError("validation", "Gitea base URL must be an absolute HTTP or HTTPS URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password ||
    parsed.search || parsed.hash) {
    throw new RuntimeError("validation", "Gitea base URL must be HTTP(S) without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/$/, "");
}
function pathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") throw new RuntimeError("validation", "Invalid Gitea path segment");
  return encodeURIComponent(trimmed);
}
function segmentString(value: unknown): value is string {
  return nonEmpty(value) && value.trim().length <= 255 && value.trim() !== "." && value.trim() !== "..";
}
function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}
function booleanValue(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function compact(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
