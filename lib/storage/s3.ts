import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import type { ObjectStorage } from "./types";

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const SAFE = /^[a-zA-Z0-9._-]+$/;
export function immutableKey(
  workspaceId: string,
  domain: string,
  filename: string
): string {
  for (const part of [workspaceId, domain, filename]) {
    if (!SAFE.test(part)) throw new Error(`unsicherer Key-Bestandteil: ${part}`);
    if (part === "." || part === "..") throw new Error(`unsicherer Key-Bestandteil: ${part}`);
  }
  return `immutable/${workspaceId}/${domain}/${filename}`;
}

export class S3Storage implements ObjectStorage {
  constructor(
    private cfg: { bucket: string },
    private client: S3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    })
  ) {}

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
    return { key };
  }

  async putImmutable(key: string, body: Buffer, contentType: string) {
    if (!key.startsWith("immutable/"))
      throw new Error("putImmutable verlangt immutable/-Key");
    // Pre-check: Fail fast if object already exists (app-level WORM enforcement)
    // Note: TOCTOU window exists between HeadObject and PutObject; IfNoneMatch on the
    // PutObject closes this race on S3-compatible providers that support conditional writes.
    // Providers that ignore IfNoneMatch fall back to pre-check semantics (residual race until
    // true Object-Lock lands in M2/M3).
    const exists = await this.client
      .send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      .then(() => true)
      .catch((e: unknown) => {
        const error = e as { $metadata?: { httpStatusCode?: number }; name?: string } | undefined;
        if (
          error?.$metadata?.httpStatusCode === 404 ||
          error?.name === "NotFound"
        ) {
          return false;
        }
        return Promise.reject(e);
      });
    if (exists)
      throw new Error(`Objekt existiert bereits (WORM): ${key}`);
    const sha256 = sha256Hex(body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        // Conditional write: fail (412 Precondition Failed) if key already exists
        // This closes the TOCTOU race on S3-compatible providers that support it
        IfNoneMatch: "*",
      })
    );
    return { key, sha256 };
  }

  async getSignedReadUrl(key: string, ttlSeconds = 300) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn: ttlSeconds }
    );
  }

  async getSignedUploadUrl(key: string, contentType: string, ttlSeconds = 600) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: ttlSeconds }
    );
  }
}
