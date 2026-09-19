import {
  RestInvalidRequestError,
  RestPayloadTooLargeError,
  RestUnsupportedMediaTypeError,
} from "./errors";

export const REST_MAX_BODY_BYTES = 256 * 1024;

export function assertRestJsonContentType(value: string | null): void {
  if (!value || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim())) {
    throw new RestUnsupportedMediaTypeError();
  }
}

export function assertNoRestContentEncoding(value: string | null): void {
  // Auch "identity" wird nicht akzeptiert: Der Vertrag signiert und verarbeitet
  // genau dieselben rohen Bytes und kennt deshalb keinen zweiten Encoding-Pfad.
  if (value !== null) throw new RestUnsupportedMediaTypeError();
}

function declaredLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) throw new RestInvalidRequestError();
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new RestInvalidRequestError();
  return length;
}

export async function readRestBody(
  request: Request,
  maxBytes: number = REST_MAX_BODY_BYTES,
): Promise<Uint8Array> {
  const length = declaredLength(request);
  if (length !== null && length > maxBytes) throw new RestPayloadTooLargeError();
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RestPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function parseRestJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RestInvalidRequestError();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RestInvalidRequestError();
  }
}
