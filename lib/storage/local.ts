import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { IMMUTABLE_PREFIX, sha256Hex } from "./s3";
import type { ObjectStorage } from "./types";

// F10-04 lokales Backend (Test/E2E/Preview ohne S3-Anbindung):
// dateisystemgestütztes ObjectStorage mit identischer Key-Disziplin
// (WORM-Präfix nur via putImmutable, Existenzprüfung fail-closed).
// KEINE signierten URLs — getSignedReadUrl/getSignedUploadUrl werfen,
// Lesen läuft dienend über get() (Server-Action/Route streamt).
// Verzeichnis: STORAGE_LOCAL_DIR, Default flüchtiges OS-Temp (kein
// Repo-/Demo-Schreibpfad, E2E räumt sein privateDirectory selbst).
function storageRoot(): string {
  const configured = process.env.STORAGE_LOCAL_DIR?.trim();
  return configured && configured.length > 0 ? configured : join(tmpdir(), "energie-saas-storage");
}

function keyToPath(root: string, key: string): string {
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) {
    throw new Error(`unsicherer Storage-Key: ${key}`);
  }
  const resolved = resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`unsicherer Storage-Key: ${key}`);
  }
  return resolved;
}

export class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string = storageRoot()) {}

  private async locate(key: string, forWrite: boolean): Promise<string> {
    const path = keyToPath(this.root, key);
    if (forWrite) {
      await mkdir(join(path, ".."), { recursive: true });
    }
    return path;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<{ key: string }> {
    if (key.startsWith(IMMUTABLE_PREFIX)) {
      throw new Error(
        `put() darf nicht auf "${IMMUTABLE_PREFIX}"-Keys angewandt werden (WORM): ${key}. ` +
          `Unveränderliche Objekte ausschließlich über putImmutable().`,
      );
    }
    const path = await this.locate(key, true);
    await writeFile(path, body);
    await writeFile(`${path}.content-type`, contentType, "utf8");
    return { key };
  }

  async putImmutable(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<{ key: string; sha256: string }> {
    if (!key.startsWith(IMMUTABLE_PREFIX)) {
      throw new Error("putImmutable verlangt immutable/-Key");
    }
    const path = await this.locate(key, true);
    try {
      await stat(path);
      throw new Error(`Objekt existiert bereits (WORM): ${key}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Objekt existiert bereits")) {
        throw error;
      }
      // ENOENT = frei, schreiben.
    }
    const sha256 = sha256Hex(body);
    await writeFile(path, body);
    await writeFile(`${path}.content-type`, contentType, "utf8");
    await writeFile(`${path}.sha256`, sha256, "utf8");
    return { key, sha256 };
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const path = keyToPath(this.root, key);
    const body = await readFile(path);
    const contentType = await readFile(`${path}.content-type`, "utf8").catch(() => "application/octet-stream");
    const pinned = await readFile(`${path}.sha256`, "utf8").catch(() => null);
    if (pinned !== null) {
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== pinned.trim()) {
        throw new Error(`Integritätsbruch im LocalStorage: ${key}`);
      }
    }
    return { body, contentType: contentType.trim() || "application/octet-stream" };
  }

  async getSignedReadUrl(): Promise<string> {
    throw new Error("LocalStorage stellt keine signierten URLs aus (Lesen via get()).");
  }

  async getSignedUploadUrl(): Promise<string> {
    throw new Error("LocalStorage stellt keine signierten URLs aus (Schreiben via put/putImmutable()).");
  }
}
