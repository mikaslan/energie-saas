// F1-17 Auto-Geocoding für den Lead-Bulk-Import: jede qualifizierte Zeile
// (residential + Straße/Hausnummer/PLZ/Ort) wird NACH createManualLead über
// search→erster Kandidat→resolve auf einen house-präzisen Standort gehoben.
// Schreibmuster wie der Bestand (correctProjectSiteAddress): selected,
// Provider-Koordinaten als Pin, follow_up=false, Revision+1, Event + Audit.
// Fail-closed je Zeile: kein Wurf, kein Retry — der Aufrufer zählt Codes.
import { sql } from "drizzle-orm";
import {
  ADDRESS_FINGERPRINT_VERSION,
  addressFingerprint,
} from "@/lib/address-fingerprint";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  resolveAddressCandidate,
  searchAddressCandidates,
  type AddressCandidate,
  type AddressSearchResult,
} from "@/lib/integrations/geocoding";
import type { ServiceCtx } from "@/lib/permissions";

export type ManualLeadBulkGeocodeError =
  | "no-candidate"
  | "provider-error"
  | "collision";

export type ManualLeadBulkGeocodeResult =
  | { ok: true; addressRevision: number }
  | { ok: false; code: ManualLeadBulkGeocodeError };

export type BulkGeocodeDeps = {
  searchAddresses: (query: string) => Promise<AddressSearchResult>;
  resolveAddress: (placeId: string) => Promise<AddressCandidate>;
};

const defaultDeps: BulkGeocodeDeps = {
  searchAddresses: searchAddressCandidates,
  resolveAddress: resolveAddressCandidate,
};

export type BulkGeocodeAddressCells = {
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
};

type QualifiedBulkGeocodeAddressCells = {
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
};

export function isBulkGeocodeQualified(
  scope: "residential" | "commercial",
  cells: BulkGeocodeAddressCells,
): cells is QualifiedBulkGeocodeAddressCells {
  return scope === "residential"
    && cells.street !== undefined
    && cells.houseNumber !== undefined
    && cells.postalCode !== undefined
    && cells.city !== undefined;
}

export function buildBulkGeocodeQuery(cells: QualifiedBulkGeocodeAddressCells): string {
  return `${cells.street} ${cells.houseNumber}, ${cells.postalCode} ${cells.city}`;
}

// Gleiche Eindeutigkeitsregel wie correctProjectSiteAddress (dort privat):
// ein Kontakt trägt eine Adresse nur einmal als selected-Standort.
function isAddressFingerprintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505"
    && candidate.constraint === "site_ws_contact_address_fingerprint_uq";
}

/**
 * Genau ein Standort-Upgrade: search→erster Kandidat→resolve→site-UPDATE.
 * Wirft nie zeilenbezogen — jeder Fehler landet als Code beim Aufrufer,
 * die Zeile bleibt created+legacy. Nur ein toter Transaktionskontext
 * (SAVEPOINT selbst scheitert) eskaliert an den Import.
 */
export async function geocodeBulkLeadSite(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    siteId: string;
    contactId: string;
    street: string;
    houseNumber: string;
    postalCode: string;
    city: string;
  },
  deps: BulkGeocodeDeps = defaultDeps,
): Promise<ManualLeadBulkGeocodeResult> {
  let candidate: AddressCandidate;
  try {
    const found = await deps.searchAddresses(buildBulkGeocodeQuery(input));
    const first = found.candidates[0];
    if (!first) return { ok: false, code: "no-candidate" };
    candidate = await deps.resolveAddress(first.placeId);
  } catch {
    return { ok: false, code: "provider-error" };
  }

  await tx.execute(sql.raw("SAVEPOINT bulk_geocode_site"));
  try {
    const locked = await tx.execute<{ address_revision: number }>(sql`
      select s.address_revision
      from site s
      where s.workspace_id = ${ctx.workspaceId}::uuid
        and s.id = ${input.siteId}::uuid
      for update
    `);
    const row = locked.rows[0];
    if (!row) throw new Error("bulk geocode site vanished");

    const fingerprint = addressFingerprint({
      countryCode: candidate.countryCode,
      postalCode: candidate.postalCode,
      city: candidate.city,
      street: candidate.street,
      houseNumber: candidate.houseNumber,
    });
    const collision = await tx.execute<{ id: string }>(sql`
      select id
      from site
      where workspace_id = ${ctx.workspaceId}::uuid
        and contact_id = ${input.contactId}::uuid
        and id <> ${input.siteId}::uuid
        and address_mode = 'selected'
        and address_fingerprint_version = ${ADDRESS_FINGERPRINT_VERSION}
        and address_fingerprint = ${fingerprint}
      limit 1
    `);
    if (collision.rows.length > 0) {
      await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT bulk_geocode_site"));
      await tx.execute(sql.raw("RELEASE SAVEPOINT bulk_geocode_site"));
      return { ok: false, code: "collision" };
    }

    const nextRevision = row.address_revision + 1;
    await tx.execute(sql`
      update site
      set formatted_address = ${candidate.formattedAddress},
          address_fingerprint = ${fingerprint},
          address_fingerprint_version = ${ADDRESS_FINGERPRINT_VERSION},
          address_mode = 'selected',
          street = ${candidate.street},
          house_number = ${candidate.houseNumber},
          postal_code = ${candidate.postalCode},
          city = ${candidate.city},
          country = ${candidate.countryCode},
          lat = ${candidate.latitude},
          lng = ${candidate.longitude},
          geocode_source = ${candidate.provider},
          geocode_place_id = ${candidate.placeId},
          geocode_precision = ${candidate.precision},
          address_follow_up_required = false,
          pin_confirmed = false,
          pin_confirmed_address_revision = null,
          pin_adjusted = false,
          address_revision = ${nextRevision},
          updated_at = now()
      where workspace_id = ${ctx.workspaceId}::uuid
        and id = ${input.siteId}::uuid
    `);

    const technicalDetails = {
      siteId: input.siteId,
      projectId: input.projectId,
      addressRevision: nextRevision,
    };
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "site",
      aggregateId: input.siteId,
      eventType: "site.address_geocoded",
      actor: ctx.actor,
      payload: technicalDetails,
    });
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: "project.write",
      resource: "site_address",
      allowed: true,
      details: technicalDetails,
    });

    await tx.execute(sql.raw("RELEASE SAVEPOINT bulk_geocode_site"));
    return { ok: true, addressRevision: nextRevision };
  } catch (error) {
    await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT bulk_geocode_site"));
    await tx.execute(sql.raw("RELEASE SAVEPOINT bulk_geocode_site"));
    if (isAddressFingerprintViolation(error)) return { ok: false, code: "collision" };
    return { ok: false, code: "provider-error" };
  }
}
