import { createHash } from "node:crypto";
import { z } from "zod";

// F2.7 PDF-Engine (R1, migrationsfrei): Fremd-PDF-Upload-Validierung.
// Rein funktional: Bytes werden geprüft (Magic, Größe, Verschlüsselung,
// Seitenzahl-Heuristik) und zu einem Deskriptor verdichtet. Bytes selbst
// überqueren nie die Render-Grenze — das Draft-HTML listet nur Dateiname,
// Seiten, Größe und SHA-256 (Byte-Merge ist Folge-Slice, Worker-Pipeline).

export const FOREIGN_PDF_MIME_TYPE = "application/pdf" as const;
export const FOREIGN_PDF_MIN_BYTES = 100;
export const FOREIGN_PDF_MAX_BYTES = 8 * 1024 * 1024;
export const FOREIGN_PDF_MAX_PAGES = 50;
export const FOREIGN_PDF_MAX_COUNT = 5;
export const FOREIGN_PDF_FILENAME_MAX = 120;

export type ForeignPdfValidationCode =
  | "bad_mime"
  | "bad_filename"
  | "too_small"
  | "too_large"
  | "not_pdf"
  | "encrypted"
  | "no_pages"
  | "too_many_pages";

export class ForeignPdfValidationError extends Error {
  constructor(public readonly code: ForeignPdfValidationCode) {
    super(`foreign PDF upload is invalid: ${code}`);
    this.name = "ForeignPdfValidationError";
  }
}

const descriptorFilenameSchema = z.string().min(1).max(FOREIGN_PDF_FILENAME_MAX)
  .refine((value) => !/[\u0000-\u001F\u007F\\/]/u.test(value), { message: "Dateiname ungueltig." })
  .refine((value) => /\.pdf$/iu.test(value), { message: "Dateiname muss auf .pdf enden." });

export const foreignPdfDescriptorSchema = z.strictObject({
  filename: descriptorFilenameSchema,
  mimeType: z.literal(FOREIGN_PDF_MIME_TYPE),
  sizeBytes: z.int().safe().min(FOREIGN_PDF_MIN_BYTES).max(FOREIGN_PDF_MAX_BYTES),
  sha256Hex: z.string().regex(/^[0-9a-f]{64}$/u),
  pageCount: z.int().safe().min(1).max(FOREIGN_PDF_MAX_PAGES),
});
export type ForeignPdfDescriptor = z.infer<typeof foreignPdfDescriptorSchema>;

export const foreignPdfDescriptorListSchema = z
  .array(foreignPdfDescriptorSchema)
  .min(1)
  .max(FOREIGN_PDF_MAX_COUNT)
  .superRefine((list, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      if (seen.has(entry.sha256Hex)) {
        context.addIssue({
          code: "custom",
          path: [index, "sha256Hex"],
          message: "Doppelte Fremd-PDF (sha256).",
        });
      }
      seen.add(entry.sha256Hex);
    }
  });

function validationPaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => {
    if (issue.path.length === 0) return "/";
    return `/${issue.path.map((part) => String(part)
      .replaceAll("~", "~0")
      .replaceAll("/", "~1")).join("/")}`;
  }))].slice(0, 20);
}

export function parseForeignPdfDescriptors(value: unknown): ForeignPdfDescriptor[] {
  const parsed = foreignPdfDescriptorListSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Ungueltige Fremd-PDF-Liste: ${validationPaths(parsed.error).join(", ")}`);
  }
  return parsed.data;
}

export function sanitizeForeignPdfFilename(value: unknown): string {
  if (typeof value !== "string") throw new ForeignPdfValidationError("bad_filename");
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 5 || normalized.length > FOREIGN_PDF_FILENAME_MAX) {
    throw new ForeignPdfValidationError("bad_filename");
  }
  if (/[\u0000-\u001F\u007F\\/]/u.test(normalized)) throw new ForeignPdfValidationError("bad_filename");
  if (!/\.pdf$/iu.test(normalized)) throw new ForeignPdfValidationError("bad_filename");
  return normalized;
}

// Heuristik über latin1-Text (1:1-Byteabbildung): zählt "/Type /Page" und
// schließt "/Pages" (Katalog-Knoten, kein Blatt) explizit aus.
export function countForeignPdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  const marker = /\/Type\s*\/Page([^sA-Za-z]|$)/gu;
  let count = 0;
  while (marker.exec(text) !== null) {
    count += 1;
    if (count > FOREIGN_PDF_MAX_PAGES) break;
  }
  return count;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

export type ValidateForeignPdfUploadInput = {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
};

export function validateForeignPdfUpload(input: ValidateForeignPdfUploadInput): ForeignPdfDescriptor {
  if (input.mimeType !== FOREIGN_PDF_MIME_TYPE) throw new ForeignPdfValidationError("bad_mime");
  const filename = sanitizeForeignPdfFilename(input.filename);
  if (!(input.bytes instanceof Uint8Array)) throw new ForeignPdfValidationError("not_pdf");
  if (input.bytes.length < FOREIGN_PDF_MIN_BYTES) throw new ForeignPdfValidationError("too_small");
  if (input.bytes.length > FOREIGN_PDF_MAX_BYTES) throw new ForeignPdfValidationError("too_large");
  const hasMagic = PDF_MAGIC.every((expected, index) => input.bytes[index] === expected);
  if (!hasMagic) throw new ForeignPdfValidationError("not_pdf");
  // Verschlüsselte PDFs würden das Folge-Merge brechen — fail-closed am Upload.
  if (/\/Encrypt\b/u.test(Buffer.from(input.bytes).toString("latin1"))) {
    throw new ForeignPdfValidationError("encrypted");
  }
  const pageCount = countForeignPdfPages(input.bytes);
  if (pageCount < 1) throw new ForeignPdfValidationError("no_pages");
  if (pageCount > FOREIGN_PDF_MAX_PAGES) throw new ForeignPdfValidationError("too_many_pages");
  return {
    filename,
    mimeType: FOREIGN_PDF_MIME_TYPE,
    sizeBytes: input.bytes.length,
    sha256Hex: createHash("sha256").update(input.bytes).digest("hex"),
    pageCount,
  };
}
