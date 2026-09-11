import { z } from "zod";

// F13-10 Kundenchat zur Förderakte — client-sicherer Anteil (Konstanten
// + Zod; kein Server-Import). Textspiegel des DB-CHECKs (getrimmt,
// 1–2000, keine Controls). Unveränderlich: kein Editieren/Löschen.
export const SUBSIDY_CHAT_BODY_MAX = 2000;

export const subsidyChatAuthorSideSchema = z.enum(["internal", "customer"]);
export type SubsidyChatAuthorSide = z.infer<typeof subsidyChatAuthorSideSchema>;

export const subsidyChatBodySchema = z
  .string()
  .transform((value) => value.normalize("NFKC").trim())
  .refine((value) => value.length >= 1 && value.length <= SUBSIDY_CHAT_BODY_MAX, {
    message: "chat-Laenge",
  })
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "chat-Steuerzeichen",
  });

export const subsidyChatPostSchema = z.strictObject({
  caseId: z.uuid(),
  body: subsidyChatBodySchema,
});

export type SubsidyChatMessage = {
  side: SubsidyChatAuthorSide;
  body: string;
  at: string;
};
