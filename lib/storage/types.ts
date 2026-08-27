export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<{ key: string }>;
  putImmutable(
    key: string,
    body: Buffer,
    contentType: string
  ): Promise<{ key: string; sha256: string }>;
  getSignedReadUrl(key: string, ttlSeconds?: number): Promise<string>;
  getSignedUploadUrl(
    key: string,
    contentType: string,
    ttlSeconds?: number
  ): Promise<string>;
}
