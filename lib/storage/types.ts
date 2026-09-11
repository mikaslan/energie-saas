export interface ObjectStorage {
  // Dienendes Lesen (Server-Action/Route streamt; kein signierter
  // URL-Umweg nötig — F10-04 interner Beleg-Download).
  get(key: string): Promise<{ body: Buffer; contentType: string }>;
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
