import { LocalStorage } from "./local";
import { S3Storage } from "./s3";
import type { ObjectStorage } from "./types";

// F10-04 Backend-Wahl (laufzeitgesteuert, kein Build-Branch):
// STORAGE_BACKEND=local → dateisystemgestützt (Test/E2E/Preview ohne
// S3-Anbindung); sonst S3-kompatibel (S3_BUCKET Pflicht). Die Wahl
// liest je Aufruf die Umgebung, damit Tests das Backend pro Fall
// umschalten können. Echte Kundendaten nie ins lokale Backend —
// produktiv ist S3 das einzige Ziel (ESTIMATE-Reversibilität: Wechsel
// jederzeit per Env, Keys sind backend-neutral).
export function resolveObjectStorage(): ObjectStorage {
  const backend = (process.env.STORAGE_BACKEND ?? "").trim().toLowerCase();
  if (backend === "local") {
    return new LocalStorage();
  }
  const bucket = (process.env.S3_BUCKET ?? "").trim();
  if (bucket.length === 0) {
    throw new Error("S3_BUCKET fehlt (oder STORAGE_BACKEND=local setzen).");
  }
  return new S3Storage({ bucket });
}
