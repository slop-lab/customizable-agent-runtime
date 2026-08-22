import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type ArtifactStatus = "partial" | "completed" | "failed";
export type ArtifactKind = "provider-request" | "provider-events" | "provider-response" | "tool-output";

export interface ArtifactOwnership {
  readonly type: "model-attempt" | "operation";
  readonly id: string;
  readonly runId: string;
}

export interface ArtifactReference {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ArtifactIngressDescriptorV1 {
  readonly version: 1;
  readonly ingressId: string;
  readonly operationId: string;
  readonly kind: "tool-output";
  readonly mediaType: "text/plain";
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ArtifactMetadata {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly relativePath: string;
  readonly status: ArtifactStatus;
  readonly byteLength: number;
  readonly sha256?: string;
  readonly createdAt: string;
  readonly finalizedAt?: string;
  readonly ownership?: ArtifactOwnership;
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

  abort(): void {
    if (this.#closed) return;
    closeSync(this.#fd);
    this.#closed = true;
    try { unlinkSync(this.partialPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class ArtifactStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }

  create(id: string, kind: ArtifactMetadata["kind"], mediaType: string, createdAt: string,
    ownership?: ArtifactOwnership): ArtifactWriter {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe artifact ID: ${id}`);
    const filename = `${id}.artifact`;
    return new ArtifactWriter({ id, kind, mediaType, relativePath: filename, status: "partial",
      byteLength: 0, createdAt, ...(ownership === undefined ? {} : { ownership }) },
    join(this.root, `${filename}.partial`), join(this.root, filename));
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


  ingest(id: string, descriptor: ArtifactIngressDescriptorV1, ingress: ArtifactIngressStore,
    ownership: ArtifactOwnership, createdAt: string): ArtifactMetadata {
    const writer = this.create(id, descriptor.kind, descriptor.mediaType, createdAt, ownership);
    try {
      writer.append(ingress.readVerified(descriptor, ownership.id));
      const metadata = writer.finalize("completed", createdAt);
      if (metadata.sha256 !== descriptor.sha256 || metadata.byteLength !== descriptor.byteLength) {
        throw new Error(`Artifact ingress changed while importing: ${descriptor.ingressId}`);
      }
      ingress.remove(descriptor);
      return metadata;
    } catch (error) {
      writer.abort();
      throw error;
    }
  }
}

export class ArtifactIngressStore {
  constructor(readonly root: string, readonly maximumBytes = 16 * 1024 * 1024) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  stageText(operationId: string, content: string): ArtifactIngressDescriptorV1 {
    const bytes = Buffer.from(content);
    if (bytes.byteLength > this.maximumBytes) {
      throw new Error(`Artifact ingress exceeds ${this.maximumBytes} bytes`);
    }
    const ingressId = randomUUID();
    const partialPath = join(this.root, `${ingressId}.partial`);
    const finalPath = join(this.root, `${ingressId}.ingress`);
    writeFileSync(partialPath, bytes, { flag: "wx", mode: 0o600 });
    renameSync(partialPath, finalPath);
    return { version: 1, ingressId, operationId, kind: "tool-output", mediaType: "text/plain",
      byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  readVerified(descriptor: ArtifactIngressDescriptorV1, expectedOperationId: string): Buffer {
    validateDescriptor(descriptor, expectedOperationId, this.maximumBytes);
    const path = this.path(descriptor.ingressId);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== descriptor.byteLength) {
        throw new Error(`Artifact ingress size mismatch: ${descriptor.ingressId}`);
      }
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== descriptor.sha256) throw new Error(`Artifact ingress hash mismatch: ${descriptor.ingressId}`);
    return bytes;
  }

  remove(descriptor: ArtifactIngressDescriptorV1): void {
    unlinkSync(this.path(descriptor.ingressId));
  }

  private path(ingressId: string): string {
    if (!/^[A-Fa-f0-9-]{36}$/.test(ingressId)) throw new Error(`Unsafe artifact ingress ID: ${ingressId}`);
    return join(this.root, `${ingressId}.ingress`);
  }
}

function validateDescriptor(descriptor: ArtifactIngressDescriptorV1, expectedOperationId: string,
  maximumBytes: number): void {
  if (descriptor.version !== 1 || descriptor.kind !== "tool-output" || descriptor.mediaType !== "text/plain") {
    throw new Error("Unsupported artifact ingress descriptor");
  }
  if (descriptor.operationId !== expectedOperationId) throw new Error("Artifact ingress ownership mismatch");
  if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0 || descriptor.byteLength > maximumBytes) {
    throw new Error("Invalid artifact ingress byte length");
  }
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error("Invalid artifact ingress SHA-256");
}
