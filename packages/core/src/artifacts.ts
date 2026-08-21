import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

export type ArtifactStatus = "partial" | "completed" | "failed";

export interface ArtifactMetadata {
  readonly id: string;
  readonly kind: "provider-request" | "provider-events" | "provider-response";
  readonly mediaType: string;
  readonly relativePath: string;
  readonly status: ArtifactStatus;
  readonly byteLength: number;
  readonly sha256?: string;
  readonly createdAt: string;
  readonly finalizedAt?: string;
}

export class ArtifactWriter {
  readonly #hash = createHash("sha256");
  readonly #fd: number;
  #length = 0;
  #closed = false;

  constructor(
    readonly metadata: ArtifactMetadata,
    private readonly partialPath: string,
    private readonly finalPath: string,
  ) {
    this.#fd = openSync(partialPath, "wx", 0o600);
  }

  append(value: string | Uint8Array): void {
    if (this.#closed) throw new Error(`Artifact already finalized: ${this.metadata.id}`);
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    writeSync(this.#fd, bytes);
    this.#hash.update(bytes);
    this.#length += bytes.byteLength;
  }

  appendJsonLine(value: unknown): void { this.append(`${JSON.stringify(value)}\n`); }

  finalize(status: Exclude<ArtifactStatus, "partial">, finalizedAt: string): ArtifactMetadata {
    if (this.#closed) throw new Error(`Artifact already finalized: ${this.metadata.id}`);
    closeSync(this.#fd);
    this.#closed = true;
    renameSync(this.partialPath, this.finalPath);
    return { ...this.metadata, status, byteLength: this.#length, sha256: this.#hash.digest("hex"), finalizedAt };
  }
}

export class ArtifactStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }

  create(id: string, kind: ArtifactMetadata["kind"], mediaType: string, createdAt: string): ArtifactWriter {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe artifact ID: ${id}`);
    const filename = `${id}.artifact`;
    return new ArtifactWriter({ id, kind, mediaType, relativePath: filename, status: "partial",
      byteLength: 0, createdAt }, join(this.root, `${filename}.partial`), join(this.root, filename));
  }

  writeJson(id: string, kind: ArtifactMetadata["kind"], value: unknown, createdAt: string): ArtifactMetadata {
    const writer = this.create(id, kind, "application/json", createdAt);
    writer.append(JSON.stringify(value));
    return writer.finalize("completed", createdAt);
  }

  read(metadata: ArtifactMetadata): string {
    if (!/^[A-Za-z0-9._-]+$/.test(metadata.relativePath)) throw new Error(`Unsafe artifact path: ${metadata.relativePath}`);
    return readFileSync(join(this.root, metadata.relativePath), "utf8");
  }
}
