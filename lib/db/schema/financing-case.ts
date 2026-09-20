import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { project } from "./project";

// F13-15 Finanzierungs-Intake: Filing-Objekt je Projekt mit Maschine
// (beantragt → bonitaet → entschieden → ausgezahlt → abgeschlossen;
// abgelehnt/storniert aus beantragt/bonitaet/entschieden, terminal).
// Genau ein aktiver Vorgang je Projekt (partial-UQ in der Migration als
// Netz + Service-Check); terminale Vorgänge bleiben Historie, Reopen nur
// via neuen Vorgang. provider_referenz opak-intern (nie im Portal),
// Volumen Cent-genau, Anzeige ganzzahlig €.
export const financingCase = pgTable(
  "financing_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    produkttyp: text("produkttyp").notNull(),
    provider: text("provider").notNull(),
    laufzeitJahre: integer("laufzeit_jahre").notNull(),
    volumenEurCents: integer("volumen_eur_cents").notNull(),
    providerReferenz: text("provider_referenz"),
    status: text("status").notNull().default("beantragt"),
    beantragtAt: timestamp("beantragt_at", { withTimezone: true }),
    entschiedenAt: timestamp("entschieden_at", { withTimezone: true }),
    ausgezahltAt: timestamp("ausgezahlt_at", { withTimezone: true }),
    abgeschlossenAt: timestamp("abgeschlossen_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("financing_case_ws_id_uq").on(t.workspaceId, t.id),
    index("financing_case_ws_project_idx").on(t.workspaceId, t.projectId, t.status),
    check("financing_case_produkttyp_ck", sql`${t.produkttyp} in ('ratenkauf', 'kredit')`),
    check("financing_case_provider_ck", sql`${t.provider} in ('bees_bears', 'psd_bank')`),
    check(
      "financing_case_status_ck",
      sql`${t.status} in (
        'beantragt', 'bonitaet', 'entschieden', 'ausgezahlt',
        'abgeschlossen', 'abgelehnt', 'storniert'
      )`,
    ),
    check("financing_case_laufzeit_ck", sql`${t.laufzeitJahre} >= 0`),
    check("financing_case_volumen_ck", sql`${t.volumenEurCents} >= 0`),
    check(
      "financing_case_referenz_ck",
      sql`${t.providerReferenz} is null or pg_catalog.length(pg_catalog.btrim(${t.providerReferenz})) between 1 and 200`,
    ),
    check("financing_case_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "financing_case_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "financing_case_project_fk",
    }),
  ],
);
