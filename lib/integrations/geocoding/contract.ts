import { z } from "zod";

const PLACE_ID_PATTERN = /^[A-Za-z0-9._~:+-]+$/;

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizedTextSchema(name: string, maximumCodePoints: number) {
  return z
    .string()
    .transform(normalizeText)
    .pipe(
      z.string()
        .refine((value) => codePointLength(value) >= 1, `${name} is required`)
        .refine(
          (value) => codePointLength(value) <= maximumCodePoints,
          `${name} is too long`,
        ),
    );
}

export const AddressSearchQuerySchema = z
  .string()
  .transform(normalizeText)
  .pipe(
    z.string()
      .refine(
        (value) => codePointLength(value) >= 5,
        "address search query is too short",
      )
      .refine(
        (value) => codePointLength(value) <= 160,
        "address search query is too long",
      ),
  );

export const AddressPlaceIdSchema = z
  .string()
  .transform(normalizeText)
  .pipe(
    z.string()
      .min(1, "address place id is required")
      .max(300, "address place id is too long")
      .regex(PLACE_ID_PATTERN, "address place id is invalid"),
  );

export const AddressCandidateSchema = z.strictObject({
  placeId: AddressPlaceIdSchema,
  formattedAddress: normalizedTextSchema("formatted address", 200),
  street: normalizedTextSchema("street", 200),
  houseNumber: normalizedTextSchema("house number", 30),
  postalCode: z.string().trim().regex(/^\d{5}$/, "postal code must contain five digits"),
  city: normalizedTextSchema("city", 200),
  countryCode: z.literal("DE"),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  provider: z.literal("geoapify"),
  precision: z.literal("house"),
});

export type AddressCandidate = z.infer<typeof AddressCandidateSchema>;

export const AddressSearchResultSchema = z.strictObject({
  candidates: z.array(AddressCandidateSchema).max(5),
});

export type AddressSearchResult = z.infer<typeof AddressSearchResultSchema>;
