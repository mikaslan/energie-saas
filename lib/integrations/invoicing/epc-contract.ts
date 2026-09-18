import { z } from "zod";

export const EPC_PAYLOAD_VERSION = "epc-payload.v1" as const;

const MAX_NAME_LENGTH = 70;
const MAX_AMOUNT_CENTS = 99999999999;
const BIC_PATTERN = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/u;
const IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/u;
const PRINTABLE_PATTERN = /^[^\p{Cc}\p{Cf}]*$/u;

export type EpcPayloadInput = {
  creditorName: string;
  creditorIban: string;
  creditorBic: string;
  amountCents: number;
  documentNumber: string;
};

export type EpcPayloadValidation =
  | { ok: true; value: string }
  | { ok: false; errors: string[] };

function mod97(digits: string): number {
  let remainder = 0;
  for (const digit of digits) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

function alphanumericsToDigits(value: string): string {
  let digits = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      digits += char;
    } else if (code >= 65 && code <= 90) {
      digits += String(code - 55);
    } else {
      return "";
    }
  }
  return digits;
}

export function isValidIban(iban: string): boolean {
  if (!IBAN_PATTERN.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = alphanumericsToDigits(rearranged);
  return digits !== "" && mod97(digits) === 1;
}

function rfCheckDigits(base: string): string {
  const digits = alphanumericsToDigits(`${base}RF00`);
  return String(98 - mod97(digits)).padStart(2, "0");
}

function isValidRfReference(reference: string): boolean {
  if (!/^RF[0-9]{2}[A-Z0-9]{1,21}$/u.test(reference)) return false;
  const rearranged = reference.slice(4) + reference.slice(0, 4);
  return mod97(alphanumericsToDigits(rearranged)) === 1;
}

function referenceBaseFromDocumentNumber(documentNumber: string): string | null {
  const base = documentNumber.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  return base.length >= 1 && base.length <= 21 ? base : null;
}

function formatEpcAmount(amountCents: number): string {
  const euros = Math.floor(amountCents / 100);
  const cents = String(amountCents % 100).padStart(2, "0");
  return `EUR${euros}.${cents}`;
}

const epcInputSchema = z.strictObject({
  creditorName: z.string().min(1).max(MAX_NAME_LENGTH).regex(
    PRINTABLE_PATTERN,
    "creditorName ohne Steuerzeichen",
  ),
  creditorIban: z.string().refine(isValidIban, "IBAN-Pruefziffern ungueltig"),
  creditorBic: z.string().refine(
    (bic) => bic === "" || BIC_PATTERN.test(bic),
    "BIC-Format ungueltig",
  ),
  amountCents: z.number().int().min(1).max(MAX_AMOUNT_CENTS),
  documentNumber: z.string().min(1).refine(
    (number) => referenceBaseFromDocumentNumber(number) !== null,
    "Dokumentnummer ohne RF-faehige Basis",
  ),
});

export class EpcPayloadError extends Error {
  constructor(
    message: string,
    public readonly paths: string[] = [],
  ) {
    super(message);
    this.name = "EpcPayloadError";
  }
}

export function buildEpcPayload(input: EpcPayloadInput): string {
  const parsed = epcInputSchema.safeParse(input);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => (
      issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`
    )))].slice(0, 20);
    throw new EpcPayloadError("EPC-Payload-Input ist ungueltig", paths);
  }
  const base = referenceBaseFromDocumentNumber(parsed.data.documentNumber);
  if (base === null) throw new EpcPayloadError("Dokumentnummer ohne RF-faehige Basis", ["/documentNumber"]);
  const reference = `RF${rfCheckDigits(base)}${base}`;
  return [
    "BCD",
    "002",
    "1",
    "SCT",
    parsed.data.creditorBic,
    parsed.data.creditorName,
    parsed.data.creditorIban,
    formatEpcAmount(parsed.data.amountCents),
    "",
    reference,
  ].join("\n");
}

export function validateEpcPayload(payload: unknown): EpcPayloadValidation {
  if (typeof payload !== "string") return { ok: false, errors: ["/: kein String"] };
  const lines = payload.split("\n");
  const errors: string[] = [];
  if (lines.length !== 10) errors.push("/: genau 10 Zeilen erwartet");
  const [service, version, coding, func, bic, name, iban, amount, purpose, reference] = lines;
  if (service !== "BCD") errors.push("/0: BCD erwartet");
  if (version !== "002") errors.push("/1: 002 erwartet");
  if (coding !== "1") errors.push("/2: UTF-8-Kennung erwartet");
  if (func !== "SCT") errors.push("/3: SCT erwartet");
  if (bic !== undefined && bic !== "" && !BIC_PATTERN.test(bic)) {
    errors.push("/4: BIC-Format ungueltig");
  }
  if (name === undefined || name.length < 1 || name.length > MAX_NAME_LENGTH) {
    errors.push("/5: Name 1-70 Zeichen");
  } else if (!PRINTABLE_PATTERN.test(name)) {
    errors.push("/5: Name ohne Steuerzeichen");
  }
  if (iban === undefined || !isValidIban(iban)) errors.push("/6: IBAN ungueltig");
  if (amount === undefined || !/^EUR[0-9]{1,9}\.[0-9]{2}$/u.test(amount)) {
    errors.push("/7: Betrag EUR+2 Dezimalstellen");
  }
  if (purpose !== undefined && purpose !== "" && !/^[A-Z0-9]{4}$/u.test(purpose)) {
    errors.push("/8: Purpose leer oder 4-stellig");
  }
  if (reference === undefined || !isValidRfReference(reference)) {
    errors.push("/9: RF-Referenz ungueltig");
  }
  return errors.length === 0 ? { ok: true, value: payload } : { ok: false, errors };
}
