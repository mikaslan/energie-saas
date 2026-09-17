import { z } from "zod";

// F7.2/F7.4 Projekt-Checkliste. Version 2 ergänzt stabile Baum-IDs,
// Phasenidentität, Pflicht-/Sichtbarkeitsstatus und serverseitige
// Segmentabschlüsse. Abschlussmetadaten gehören absichtlich nicht zum
// Edit-Command: normale Whole-Tree-Saves können sie weder fälschen noch
// versehentlich entfernen.
export const CHECKLIST_SCHEMA_VERSION = 2;

export const CHECKLIST_BLOCK_NAME_MAX = 200;
export const CHECKLIST_SEGMENT_NAME_MAX = 200;
export const CHECKLIST_ITEM_TITLE_MAX = 500;
// F7-02C: Fließtext-Maximum für Anzeige-Punkte (spiegelt den DB-Validator).
export const CHECKLIST_ITEM_DESCRIPTION_MAX = 2000;
// F7-02E: Antworttext-Maximum für Textpunkte (spiegelt den DB-Validator;
// bewusst eigene Konstante statt Alias, damit beide Schranken getrennt
// versionierbar bleiben).
export const CHECKLIST_ITEM_VALUE_MAX = 2000;
// F7-02G: Foto-Key (Service-seitig gebaut, projekt-skoped). Das Format
// spiegelt den DB-Validator 0173 (max. 500 Zeichen).
export const CHECKLIST_ITEM_PHOTO_MAX = 500;
export const CHECKLIST_ITEM_PHOTO_KEY_PATTERN =
  /^immutable\/[0-9a-f-]{36}\/checklist-photos\/[0-9a-f-]{36}_[0-9a-f]{8}\.(jpg|jpeg|png)$/;
// F7-04b: Begründungs-Maximum (UTF-16-Einheiten, spiegelt
// public._f704_valid_clean_text(..., 500) in Migration 0127).
export const CHECKLIST_ITEM_IRRELEVANT_REASON_MAX = 500;
export const CHECKLIST_TITLE_MAX = 200;
export const CHECKLIST_BLOCKS_MAX = 50;
export const CHECKLIST_SEGMENTS_MAX = 100;
export const CHECKLIST_ITEMS_MAX = 500;
// Muss mit public._f704_valid_checklist_blocks in Migration 0077
// uebereinstimmen; PostgreSQL-seitig bewusst als signed int32 begrenzt.
export const CHECKLIST_POSITION_MAX = 2_147_483_647;
// Global statt nur pro Ebene: selbst ein formal gueltiger Maximalbaum darf
// nicht 50 * 100 * 500 Punkte und damit unbeschraenkte Validierungsarbeit
// ausloesen. 500 Knoten bleiben fuer eine operative Projekt-Checkliste sehr
// grosszuegig und garantieren gemeinsam mit den Textmaxima, dass selbst der
// gueltige UTF-8-Worstcase unter dem gepinnten 1-MiB-Action-Transport bleibt.
// Muss mit public._f704_valid_checklist_blocks in Migration 0077 uebereinstimmen.
export const CHECKLIST_NODES_MAX = 500;
export const CHECKLIST_BLOCKS_TRANSPORT_MAX_BYTES = 900_000;

export const checklistPhaseSchema = z.enum([
  "qualification",
  "consultation",
  "site_documentation",
]);
export type ChecklistPhase = z.infer<typeof checklistPhaseSchema>;

const cleanText = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFKC").trim())
    .refine((value) => value.length >= 1 && value.length <= max, {
      message: "ungültige Länge",
    })
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
      message: "Steuerzeichen",
    })
    // Unter /u matcht die Range nur ungepaarte UTF-16-Surrogates; gueltige
    // Astralzeichen wie 😀 werden als ein Unicode-Scalar behandelt.
    .refine((value) => !/[\uD800-\uDFFF]/u.test(value), {
      message: "ungültiges Unicode",
    });

const stableUuidSchema = z.uuid().transform((value) => value.toLowerCase());
const checklistPositionSchema = z.number().int().min(0).max(CHECKLIST_POSITION_MAX);

// F7-04b: „Als irrelevant markieren" (Katalog F7.2, mit Begründung).
// Item-Attribut wie done/required (kein Siegel-Metadatum): Whole-Tree-
// Saves erhalten es, setzen/löschen darf nur die dedizierte Op (serverseitige
// Begründungspflicht). NULL/fehlend = relevant.
export const checklistItemIrrelevantSchema = z.object({
  reason: cleanText(CHECKLIST_ITEM_IRRELEVANT_REASON_MAX),
  by: stableUuidSchema,
  at: z.iso.datetime({ offset: true }),
}).strict();
export type ChecklistItemIrrelevantV1 = z.infer<typeof checklistItemIrrelevantSchema>;

// F7-02B: Bedingte Sichtbarkeit (if/then, Katalog F7.2). Regel als Ganzes
// oder gar nicht (nullish): „Zeige mich, wenn Punkt itemId erledigt
// (equals true) bzw. unerledigt (equals false) ist". Single-Hop: Die
// Auswertung liest das RAW-done-Flag, keine effektive Sichtbarkeit —
// Zyklen sind deterministisch und schleifenfrei; Selbstreferenz und
// segmentfremde Referenzen weist die Baumvalidierung ab.
export const checklistItemVisibleIfSchema = z.object({
  itemId: stableUuidSchema,
  equals: z.boolean(),
}).strict();
export type ChecklistItemVisibleIfV1 = z.infer<typeof checklistItemVisibleIfSchema>;

// F7-02C: Anzeige-Punkte (Katalog F7.2, live beobachtete Typen title und
// description). Nullish wie irrelevant/visibleIf: fehlend/null = Aufgabe,
// kein Bestand bricht. Anzeige-Punkte sind nicht abhakbar und nie Pflicht.
// F7-02D: Einfachauswahl (Katalog F7.2, Slice B). `radio` ist abhakbar wie
// Aufgabe; Exklusivitaet (hoechstens ein erledigter Radio-Punkt je Segment)
// prueft die Baumvalidierung unten (Scope spiegelt visibleIf-Regeln).
// F7-02E: Freitext-Antwort (Katalog F7.2, Slice B ohne Diktat). `text` ist
// abhakbar wie Aufgabe und trägt optional `value` (Antworttext, nur dort).
// F7-02G: Bild-Punkt (Katalog F7.2). `image` ist abhakbar wie Aufgabe und
// trägt optional `photo` (Foto-Key, nur dort).
// F7-02I: Unterschrift-Punkt (Katalog F7.2). `signature` ist abhakbar wie
// Aufgabe, nutzt `photo` für das Signatur-PNG und trägt optional
// `signerRole` (Rollen-Typ, nur dort, Struktur).
export const checklistItemKindSchema = z.enum(["task", "title", "description", "radio", "text", "multi", "image", "signature"]);
export const checklistItemSignerRoleSchema = z.enum(["kunde", "techniker", "dritter"]);
export type ChecklistItemSignerRoleV1 = z.infer<typeof checklistItemSignerRoleSchema>;
export type ChecklistItemKindV1 = z.infer<typeof checklistItemKindSchema>;

export const editableChecklistItemSchema = z.object({
  id: stableUuidSchema,
  title: cleanText(CHECKLIST_ITEM_TITLE_MAX),
  done: z.boolean(),
  required: z.boolean(),
  visible: z.boolean(),
  // F7-13: Vorlagen-Identität für Merge (Katalog F7.3). Nullish = Legacy-
  // Bestand ohne Feld bleibt gültig; Merge matcht dann per exaktem Titel.
  componentId: stableUuidSchema.nullish(),
  irrelevant: checklistItemIrrelevantSchema.nullish(),
  visibleIf: checklistItemVisibleIfSchema.nullish(),
  kind: checklistItemKindSchema.nullish(),
  description: cleanText(CHECKLIST_ITEM_DESCRIPTION_MAX).nullish(),
  // F7-02E: Antworttext nur am Textpunkt (Regel unten; Spiegel zu description).
  value: cleanText(CHECKLIST_ITEM_VALUE_MAX).nullish(),
  // F7-02G: Foto-Key nur am Bildpunkt (Regel unten; Spiegel zu value).
  // F7-02I: am Signaturpunkt wiederverwendet (Signatur-PNG).
  // Kein cleanText: Der Key ist ein ASCII-Format mit eigenem Muster.
  photo: z.string().min(1).max(CHECKLIST_ITEM_PHOTO_MAX)
    .regex(CHECKLIST_ITEM_PHOTO_KEY_PATTERN).nullish(),
  // F7-02I: Rollen-Typ nur am Signaturpunkt (Regel unten; Struktur).
  signerRole: checklistItemSignerRoleSchema.nullish(),
}).strict();
export type ChecklistItemV1 = z.infer<typeof editableChecklistItemSchema>;

export const editableChecklistSegmentSchema = z.object({
  id: stableUuidSchema,
  name: cleanText(CHECKLIST_SEGMENT_NAME_MAX),
  position: checklistPositionSchema,
  visible: z.boolean(),
  items: z.array(editableChecklistItemSchema).max(CHECKLIST_ITEMS_MAX),
}).strict();
export type EditableChecklistSegmentV2 = z.infer<typeof editableChecklistSegmentSchema>;

export const checklistSegmentSchema = editableChecklistSegmentSchema.extend({
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  completedById: stableUuidSchema.nullable(),
}).refine(
  (segment) => (segment.completedAt === null) === (segment.completedById === null),
  { message: "Abschlusszeit und Actor müssen gemeinsam gesetzt sein" },
);
export type ChecklistSegmentV1 = z.infer<typeof checklistSegmentSchema>;

// F7-02H: Block-Fälligkeitsdatum (Kalendertag, Katalog F7.2). Format
// plus Echtheit (weist 2026-02-31 ab); spiegelt DB-Validator 0174.
export const CHECKLIST_BLOCK_DUE_DATE_PATTERN =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

export function isChecklistCalendarDate(value: string): boolean {
  if (!CHECKLIST_BLOCK_DUE_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, day!));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month! - 1
    && probe.getUTCDate() === day;
}

export const checklistBlockDueDateSchema = z.string()
  .regex(CHECKLIST_BLOCK_DUE_DATE_PATTERN)
  .refine(isChecklistCalendarDate, { message: "Fälligkeitsdatum ist kein Kalendertag" })
  .nullish();

export const editableChecklistBlockSchema = z.object({
  id: stableUuidSchema,
  name: cleanText(CHECKLIST_BLOCK_NAME_MAX),
  position: checklistPositionSchema,
  visible: z.boolean(),
  // F7-02H: Struktur-Metadatum (kein Gate, kein Strip).
  dueDate: checklistBlockDueDateSchema,
  segments: z.array(editableChecklistSegmentSchema).max(CHECKLIST_SEGMENTS_MAX),
}).strict();
export type EditableChecklistBlockV2 = z.infer<typeof editableChecklistBlockSchema>;

// F7-05b: Block-Team-Zuweisung (Katalog F7.5, mehrere Teams parallel).
// Anzeige-only: Saves schreiben ganze Bäume ohne dieses Feld (Validator
// lehnt es ab, toEditableChecklistBlocks verwirft es) — kein Schmuggelpfad.
export const checklistBlockAssignedTeamSchema = z.object({
  teamId: stableUuidSchema,
  // Anzeige-Only (DB-CHECK team_name_ck begrenzt); bewusst ohne
  // cleanText-Normalisierung, damit kein gültiger Teamname je crasht.
  teamName: z.string().min(1),
  active: z.boolean(),
}).strict();
export type ChecklistBlockAssignedTeamV1 = z.infer<typeof checklistBlockAssignedTeamSchema>;

export const checklistBlockSchema = z.object({
  id: stableUuidSchema,
  name: cleanText(CHECKLIST_BLOCK_NAME_MAX),
  position: checklistPositionSchema,
  visible: z.boolean(),
  // F7-02H: Struktur-Metadatum (Lesesicht wie Edit-Sicht).
  dueDate: checklistBlockDueDateSchema,
  segments: z.array(checklistSegmentSchema).max(CHECKLIST_SEGMENTS_MAX),
  assignedTeams: z.array(checklistBlockAssignedTeamSchema).max(50),
}).strict();
export type ChecklistBlockV1 = z.infer<typeof checklistBlockSchema>;

function rawChecklistNodeCountExceedsLimit(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  let nodeCount = 0;
  for (const block of value) {
    nodeCount += 1;
    if (nodeCount > CHECKLIST_NODES_MAX) return true;
    if (typeof block !== "object" || block === null || !("segments" in block)) continue;
    const segments = block.segments;
    if (!Array.isArray(segments)) continue;
    for (const segment of segments) {
      nodeCount += 1;
      if (nodeCount > CHECKLIST_NODES_MAX) return true;
      if (typeof segment !== "object" || segment === null || !("items" in segment)) continue;
      const items = segment.items;
      if (!Array.isArray(items)) continue;
      nodeCount += items.length;
      if (nodeCount > CHECKLIST_NODES_MAX) return true;
    }
  }
  return false;
}

const checklistNodeLimitGuard = z.unknown().superRefine((value, context) => {
  if (rawChecklistNodeCountExceedsLimit(value)) {
    context.addIssue({
      code: "custom",
      message: `Checkliste darf hoechstens ${CHECKLIST_NODES_MAX} Knoten enthalten`,
    });
  }
  try {
    const serialized = JSON.stringify(value);
    if (
      serialized !== undefined
      && new TextEncoder().encode(serialized).byteLength
        > CHECKLIST_BLOCKS_TRANSPORT_MAX_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Checkliste überschreitet das Transportlimit",
      });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Checkliste ist nicht serialisierbar" });
  }
});

function addChecklistTreeValidation<T extends z.ZodTypeAny>(schema: T) {
  // Die rohe, frueh abbrechende Schranke laeuft vor der tiefen Zod-Validierung.
  // Dadurch werden bei Oversize hoechstens CHECKLIST_NODES_MAX + 1 Knoten
  // betrachtet; erst ein begrenzter Baum erreicht die Feldvalidatoren.
  return checklistNodeLimitGuard.pipe(schema).superRefine((blocks, context) => {
    const seen = new Set<string>();
    for (const block of blocks as Array<{
      id: string;
      segments: Array<{
        id: string;
        items: Array<{
          id: string;
          done: boolean;
          required: boolean;
          kind?: string | null;
          description?: string | null;
          value?: string | null;
          photo?: string | null;
          signerRole?: string | null;
          visibleIf?: { itemId: string } | null;
        }>;
      }>;
    }>) {
      const addIdentity = (kind: string, id: string) => {
        if (seen.has(id)) {
          context.addIssue({
            code: "custom",
            message: `${kind}-ID ist innerhalb der Checkliste nicht eindeutig`,
          });
        }
        seen.add(id);
      };

      addIdentity("Block", block.id);
      for (const segment of block.segments) {
        addIdentity("Segment", segment.id);
        for (const item of segment.items) addIdentity("Punkt", item.id);
        // F7-02B: Regelreferenzen muessen im selben Segment auf einen
        // anderen Punkt zeigen (keine Selbstreferenz, kein Baumeln).
        const segmentItemIds = new Set(segment.items.map((item) => item.id));
        for (const item of segment.items) {
          const rule = item.visibleIf;
          if (rule == null) continue;
          if (rule.itemId === item.id || !segmentItemIds.has(rule.itemId)) {
            context.addIssue({
              code: "custom",
              message: "Sichtbarkeitsregel verweist nicht auf einen anderen Punkt desselben Segments",
            });
          }
        }
        // F7-02C: Anzeige-Punkte tragen weder Pflicht/Erledigt noch fremden
        // Fließtext (keine Mischbestände, kein stilles Ignorieren).
        // F7-02D: `radio` ist kein Anzeige-Punkt (abhakbar wie Aufgabe).
        // F7-02E: `text` ist kein Anzeige-Punkt (abhakbar wie Aufgabe).
        // F7-02F: `multi` ist kein Anzeige-Punkt (abhakbar wie Aufgabe,
        // ohne Exklusivitaet — Gegenstueck zu `radio`).
        for (const item of segment.items) {
          if (item.description != null && item.kind !== "description") {
            context.addIssue({
              code: "custom",
              message: "Beschreibungstext verlangt einen Beschreibungspunkt",
            });
          }
          // F7-02E: Antworttext verlangt einen Textpunkt (Spiegel-Regel).
          if (item.value != null && item.kind !== "text") {
            context.addIssue({
              code: "custom",
              message: "Antworttext verlangt einen Textpunkt",
            });
          }
          // F7-02G: Foto verlangt einen Bildpunkt (Spiegel-Regel).
          // F7-02I: am Signaturpunkt wiederverwendet (Signatur-PNG).
          if (item.photo != null && item.kind !== "image" && item.kind !== "signature") {
            context.addIssue({
              code: "custom",
              message: "Foto verlangt einen Bild- oder Unterschrift-Punkt",
            });
          }
          // F7-02I: Rollen-Typ verlangt einen Unterschrift-Punkt.
          if (item.signerRole != null && item.kind !== "signature") {
            context.addIssue({
              code: "custom",
              message: "Rollen-Typ verlangt einen Unterschrift-Punkt",
            });
          }
          if (item.kind != null && item.kind !== "task" && item.kind !== "radio"
            && item.kind !== "text" && item.kind !== "multi" && item.kind !== "image"
            && item.kind !== "signature" && (item.required || item.done)) {
            context.addIssue({
              code: "custom",
              message: "Anzeigepunkte sind weder Pflicht noch abhakbar",
            });
          }
        }
        // F7-02D: Einfachauswahl — höchstens ein erledigter Radio-Punkt je
        // Segment (fail-closed wie DB-Validator 0141; Scope spiegelt
        // visibleIf-Regeln).
        const doneRadioCount = segment.items.filter(
          (item) => item.kind === "radio" && item.done,
        ).length;
        if (doneRadioCount > 1) {
          context.addIssue({
            code: "custom",
            message: "Je Segment ist höchstens ein Radio-Punkt auswählbar",
          });
        }
      }
    }
  });
}

export const editableChecklistBlocksSchema = addChecklistTreeValidation(
  z.array(editableChecklistBlockSchema).max(CHECKLIST_BLOCKS_MAX),
);
export type EditableChecklistBlocksV2 = z.infer<typeof editableChecklistBlocksSchema>;

export const checklistBlocksSchema = addChecklistTreeValidation(
  z.array(checklistBlockSchema).max(CHECKLIST_BLOCKS_MAX),
);
export type ChecklistBlocksV1 = z.infer<typeof checklistBlocksSchema>;

export const projectChecklistDtoSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_SCHEMA_VERSION),
  checklistId: stableUuidSchema.nullable(),
  projectId: stableUuidSchema,
  phase: checklistPhaseSchema,
  title: cleanText(CHECKLIST_TITLE_MAX),
  // version 0 = Leer-Read (keine Zeile).
  version: z.number().int().min(0),
  blocks: checklistBlocksSchema,
  updatedAt: z.iso.datetime({ offset: true }),
  permissions: z.object({
    canWrite: z.boolean(),
    canConfigure: z.boolean(),
    canComplete: z.boolean(),
    canUnlock: z.boolean(),
  }),
}).strict();
export type ProjectChecklistDto = z.infer<typeof projectChecklistDtoSchema>;

export const saveProjectChecklistCommandSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_SCHEMA_VERSION),
  checklistId: stableUuidSchema.nullable(),
  projectId: stableUuidSchema,
  phase: checklistPhaseSchema,
  title: cleanText(CHECKLIST_TITLE_MAX),
  baseVersion: z.number().int().min(0),
  blocks: editableChecklistBlocksSchema,
}).strict();
export type SaveProjectChecklistCommand = z.infer<typeof saveProjectChecklistCommandSchema>;

export const mutateChecklistSegmentCommandSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_SCHEMA_VERSION),
  checklistId: stableUuidSchema,
  projectId: stableUuidSchema,
  segmentId: stableUuidSchema,
  baseVersion: z.number().int().min(1),
}).strict();
export type MutateChecklistSegmentCommand = z.infer<typeof mutateChecklistSegmentCommandSchema>;

// F7-04b: reason = null → Markierung aufheben (idempotent); sonst setzen
// (Begründungspflicht serverseitig in Migration 0127).
export const setChecklistItemIrrelevantCommandSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_SCHEMA_VERSION),
  checklistId: stableUuidSchema,
  projectId: stableUuidSchema,
  segmentId: stableUuidSchema,
  itemId: stableUuidSchema,
  baseVersion: z.number().int().min(1),
  reason: z.string().max(CHECKLIST_ITEM_IRRELEVANT_REASON_MAX * 4).nullable(),
}).strict();
export type SetChecklistItemIrrelevantCommand = z.infer<typeof setChecklistItemIrrelevantCommandSchema>;

// F7-05b: Block-Team-Zuweisung (assign/unassign teilen das Command;
// Mengen-Idempotenz, keine Revision).
export const setChecklistBlockTeamCommandSchema = z.object({
  schemaVersion: z.literal(CHECKLIST_SCHEMA_VERSION),
  checklistId: stableUuidSchema,
  projectId: stableUuidSchema,
  blockId: stableUuidSchema,
  teamId: stableUuidSchema,
}).strict();
export type SetChecklistBlockTeamCommand = z.infer<typeof setChecklistBlockTeamCommandSchema>;

export function withOpenSegmentMetadata(
  blocks: EditableChecklistBlocksV2,
): ChecklistBlocksV1 {
  return blocks.map((block) => ({
    ...block,
    assignedTeams: [],
    segments: block.segments.map((segment) => ({
      ...segment,
      completedAt: null,
      completedById: null,
    })),
  }));
}

export function toEditableChecklistBlocks(
  blocks: ChecklistBlocksV1,
): EditableChecklistBlocksV2 {
  return blocks.map((block) => ({
    id: block.id,
    name: block.name,
    position: block.position,
    visible: block.visible,
    // F7-02H: Struktur-Metadatum mittragen (sonst stiller Verlust).
    dueDate: block.dueDate,
    segments: block.segments.map((segment) => ({
      id: segment.id,
      name: segment.name,
      position: segment.position,
      visible: segment.visible,
      items: segment.items.map((item) => ({ ...item })),
    })),
  }));
}

// F7-02B: effektive Sichtbarkeit mit if/then-Regel (Single-Hop über das
// RAW-done-Flag; fehlende Referenz → sichtbar, Schreibzeit verweigert
// baumelnde Referenzen fail-closed).
export function isItemEffectivelyVisible(
  item: Pick<ChecklistItemV1, "visible" | "done" | "visibleIf">,
  byId: ReadonlyMap<string, Pick<ChecklistItemV1, "done">>,
): boolean {
  if (!item.visible) return false;
  const rule = item.visibleIf;
  if (rule == null) return true;
  const referenced = byId.get(rule.itemId);
  return referenced == null || referenced.done === rule.equals;
}

function segmentItemsById(
  segment: Pick<ChecklistSegmentV1, "items">,
): Map<string, Pick<ChecklistItemV1, "done">> {
  return new Map(segment.items.map((item) => [item.id, item]));
}

// F7-02C: Nur Aufgabenpunkte sind Arbeitsgegenstand der Gates; Anzeige-
// Punkte (title/description) zählen nie (spiegelt Migration 0130: Sie
// können kein required tragen).
// F7-02D: Radio-Punkte sind Arbeitsgegenstand wie Aufgaben (abhakbar,
// Pflicht-fähig; Exklusivität sichert die Baumvalidierung).
// F7-02E: Textpunkte ebenso (Antworttext ist Nutzlast, kein Gate).
// F7-02F: Multi-Punkte ebenso (mehrere erledigte je Segment legal —
// ohne Exklusivität, Gegenstück zu `radio`).
// F7-03C: Anzeige-Platzhalter (Katalog F7.2). {{kunde}}/{{datum}} in
// Punkt-Texten werden BEIM ANZEIGEN ersetzt; der Tree speichert den
// Rohtext. Case-insensitiv, Whitespace-tolerant, mehrfach. Unbekannte
// Muster (inkl. {{komponenten}} — deferred, keine eindeutige Quelle)
// bleiben stehen; leerer Kundenname ersetzt nicht (kein Phantom-Text).
const CHECKLIST_PLACEHOLDER_PATTERN = /\{\{\s*(kunde|datum)\s*\}\}/giu;

export function substituteChecklistPlaceholders(
  text: string,
  values: { customerName: string; today: string },
): string {
  if (text === "" || !text.includes("{{")) return text;
  return text.replace(CHECKLIST_PLACEHOLDER_PATTERN, (_match, name: string) => {
    const key = name.toLowerCase();
    if (key === "kunde") return values.customerName === "" ? _match : values.customerName;
    return values.today;
  });
}

// F7-02G: Bildpunkte ebenso (Foto ist Nutzlast, kein Gate).
// F7-02I: Unterschrift-Punkte ebenso (Signatur ist Nutzlast).
export function isChecklistWorkItem(
  item: Pick<ChecklistItemV1, "kind">,
): boolean {
  return item.kind == null || item.kind === "task" || item.kind === "radio"
    || item.kind === "text" || item.kind === "multi" || item.kind === "image"
    || item.kind === "signature";
}

export function segmentRequiredRemaining(
  segment: Pick<ChecklistSegmentV1, "items">,
): number {
  // F7-04b: irrelevant markierte Pflichtpunkte zählen nicht (Gate-Skip
  // spiegelt Migration 0127 im Complete-Gate). F7-02B: bedingt versteckte
  // Pflichtpunkte zählen nicht (spiegelt Migration 0129).
  const byId = segmentItemsById(segment);
  return segment.items.filter(
    (item) => item.required && !item.done && item.irrelevant == null
      && isChecklistWorkItem(item)
      && isItemEffectivelyVisible(item, byId),
  ).length;
}

export function segmentItemProgress(
  segment: Pick<ChecklistSegmentV1, "items">,
): { done: number; total: number } {
  const byId = segmentItemsById(segment);
  const visibleItems = segment.items.filter(
    (item) => isChecklistWorkItem(item) && isItemEffectivelyVisible(item, byId),
  );
  return {
    done: visibleItems.filter((item) => item.done).length,
    total: visibleItems.length,
  };
}

// Reonic rollt den Checklistenfortschritt auf Segmentebene auf. Unsichtbare
// Blöcke/Segmente zählen nicht; Item-Fortschritt wird separat dargestellt.
export function checklistProgress(
  blocks: ChecklistBlocksV1,
): { done: number; total: number } {
  const visibleSegments = blocks
    .filter((block) => block.visible)
    .flatMap((block) => block.segments.filter((segment) => segment.visible));
  return {
    done: visibleSegments.filter((segment) => segment.completedAt !== null).length,
    total: visibleSegments.length,
  };
}
