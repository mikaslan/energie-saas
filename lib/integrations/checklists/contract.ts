import { z } from "zod";

// F7.2 Projekt-Checkliste — interner DTO-/Command-Vertrag (Slice A).
// OBSERVED-Teilmenge: Blocks → Segmente → Items {title, done}.
// Item-Typen (radio/image/description) = Slice B (ESTIMATE).

export const CHECKLIST_SCHEMA_VERSION = 1;

export const CHECKLIST_BLOCK_NAME_MAX = 200;
export const CHECKLIST_SEGMENT_NAME_MAX = 200;
export const CHECKLIST_ITEM_TITLE_MAX = 500;
export const CHECKLIST_BLOCKS_MAX = 50;
export const CHECKLIST_SEGMENTS_MAX = 100;
export const CHECKLIST_ITEMS_MAX = 500;

const cleanText = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFKC").trim())
    .refine((v) => v.length >= 1 && v.length <= max, { message: "ungültige Länge" })
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

const checklistItemSchema = z.object({
  title: cleanText(CHECKLIST_ITEM_TITLE_MAX),
  done: z.boolean(),
});
export type ChecklistItemV1 = z.infer<typeof checklistItemSchema>;

const checklistSegmentSchema = z.object({
  name: cleanText(CHECKLIST_SEGMENT_NAME_MAX),
  position: z.number().int().min(0),
  items: z.array(checklistItemSchema).max(CHECKLIST_ITEMS_MAX),
});
export type ChecklistSegmentV1 = z.infer<typeof checklistSegmentSchema>;

const checklistBlockSchema = z.object({
  name: cleanText(CHECKLIST_BLOCK_NAME_MAX),
  position: z.number().int().min(0),
  segments: z.array(checklistSegmentSchema).max(CHECKLIST_SEGMENTS_MAX),
});
export type ChecklistBlockV1 = z.infer<typeof checklistBlockSchema>;

export const checklistBlocksSchema = z.array(checklistBlockSchema).max(CHECKLIST_BLOCKS_MAX);
export type ChecklistBlocksV1 = z.infer<typeof checklistBlocksSchema>;

export const projectChecklistDtoSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_SCHEMA_VERSION),
  projectId: z.string().uuid(),
  // version 0 = Leer-Read (keine Zeile) — F4.6-Read-Semantik.
  version: z.number().int().min(0),
  blocks: checklistBlocksSchema,
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type ProjectChecklistDto = z.infer<typeof projectChecklistDtoSchema>;

export const saveProjectChecklistCommandSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_SCHEMA_VERSION),
  projectId: z.string().uuid(),
  baseVersion: z.number().int().min(0),
  blocks: checklistBlocksSchema,
});
export type SaveProjectChecklistCommand = z.infer<typeof saveProjectChecklistCommandSchema>;

export function checklistProgress(blocks: ChecklistBlocksV1): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const block of blocks) {
    for (const segment of block.segments) {
      for (const item of segment.items) {
        total += 1;
        if (item.done) done += 1;
      }
    }
  }
  return { done, total };
}
