import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { DeniedState } from "../../anfragen/[projectId]/_ui";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  getOfferDetail,
  listOfferPdfDrafts,
  listOfferReleaseCandidates,
  OfferReleaseProfileNotFoundError,
  readCurrentOfferRecipient,
  readCurrentOfferReleaseProfile,
  type CurrentOfferReleaseProfileResult,
  type OfferDetailViewModel,
  type OfferPdfDraftStatusResult,
  type OfferRecipientRevisionResult,
  type OfferReleaseStatusResult,
} from "@/modules/offers";
import { requireAuthSecret } from "@/lib/env";
import {
  OfferDetailView,
  type OfferDetailSurfaceView,
} from "./offer-detail-view";

export const metadata: Metadata = {
  title: "Angebotsentwurf | WMEE Vertrieb",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
  offerId: z.uuid(),
});
const variantUuidSchema = z.uuid().transform((value) => value.toLowerCase());

const moneyCentsSchema = z.int().safe().min(0).max(9_000_000_000_000_000);
const signedMoneyCentsSchema = z.int().safe()
  .min(-9_000_000_000_000_000)
  .max(9_000_000_000_000_000);
const basisPointsSchema = z.int().safe().min(0).max(10_000);
const positiveRevisionSchema = z.int().safe().min(1);
const snapshotUuidSchema = z.uuid().transform((value) => value.toLowerCase());
const snapshotTextSchema = z.string().trim().min(1).max(1_000);
const releaseValidityWindowSchema = z.object({
  min: z.iso.date(),
  suggested: z.iso.date(),
  max: z.iso.date(),
}).strict();
type ReleaseValidityWindow = z.infer<typeof releaseValidityWindowSchema>;

function offerRecoveryScope(workspaceId: string, actor: string): string {
  // Runtime ist der Auth-Schlüssel fail-closed gesetzt. Der feste Test-Fallback
  // wird ausschließlich verwendet, wenn requireAuthSecret in Build/Vitest
  // absichtlich leer zurückgibt; er erreicht keine laufende Anwendung.
  const key = requireAuthSecret() || "offer-recovery-scope-test-only";
  return createHmac("sha256", key)
    .update(`${workspaceId}:${actor}`, "utf8")
    .digest("hex");
}

// Jede Object-Grenze nutzt strip() bewusst als Positivliste: Nur Felder, die
// diese Oberfläche tatsächlich rendert, verlassen die serverseitige Page.
// Insbesondere werden Vollhashes, technische Rohdaten und Akteur-IDs nicht
// durchgereicht. Sichtbare Quellen-/Preisarten sind eine eigene, kleine
// Positivliste; EK/Marge verlassen diese Grenze nur bei EK-Berechtigung.
const productViewSchema = z.object({
  kind: z.enum(["catalog", "custom"]),
  displayName: snapshotTextSchema,
  description: z.string().trim().min(1).max(1_000).nullable().optional(),
  manufacturer: z.string().trim().min(1).max(200).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  unit: z.enum(["piece", "set", "meter"]),
}).strip();

const pricingProvenanceViewSchema = z.object({
  kind: z.enum(["catalog_seed", "manual_override", "custom"]),
  reasonCode: z.enum([
    "customer_specific_pricing",
    "negotiated",
    "correction",
    "other",
  ]).optional(),
  originalProvenance: z.object({
    kind: z.enum(["catalog_seed", "custom"]),
  }).strip().optional(),
}).strip();

const salesPricingViewSchema = z.object({
  originalUnitNetCents: moneyCentsSchema,
  effectiveUnitNetCents: moneyCentsSchema,
  provenance: pricingProvenanceViewSchema,
}).strip();

const privatePricingViewSchema = salesPricingViewSchema;

const publicComputedViewSchema = z.object({
  lineBaseNetCents: moneyCentsSchema,
  lineDiscountedNetCents: moneyCentsSchema,
  sectionDiscountedNetCents: moneyCentsSchema,
  finalSalesNetCents: moneyCentsSchema,
  salesTaxCents: moneyCentsSchema,
  salesGrossCents: moneyCentsSchema,
}).strip();

const publicLineViewSchema = z.object({
  lineDomainId: snapshotUuidSchema,
  position: z.int().safe().min(1).max(500),
  positionType: z.enum(["required", "additional", "optional"]),
  isHidden: z.boolean(),
  quantityMilli: z.int().safe().min(1).max(100_000_000),
  componentCategory: z.enum([
    "module", "inverter", "battery", "wallbox", "heat_pump", "mounting", "other",
  ]),
  source: z.object({ kind: z.enum(["catalog", "custom"]) }).strip(),
  product: productViewSchema,
  salesPricing: salesPricingViewSchema,
  lineDiscountBps: basisPointsSchema,
  taxTreatment: z.enum(["standard_19", "zero_operator_confirmed"]),
  taxRateBps: z.union([z.literal(0), z.literal(1_900)]),
  computed: publicComputedViewSchema,
}).strip();

const purchaseComputedViewSchema = publicComputedViewSchema.extend({
  purchaseNetCents: moneyCentsSchema.optional(),
  marginNetCents: signedMoneyCentsSchema.optional(),
}).strip();

const purchaseLineViewSchema = publicLineViewSchema.extend({
  salesPricing: privatePricingViewSchema,
  purchasePricing: privatePricingViewSchema,
  computed: purchaseComputedViewSchema,
}).strip();

function sectionViewSchema(lineSchema: typeof publicLineViewSchema | typeof purchaseLineViewSchema) {
  return z.object({
    sectionDomainId: snapshotUuidSchema,
    position: z.int().safe().min(1).max(25),
    title: z.string().trim().min(1).max(120),
    category: z.enum([
      "module", "inverter", "battery", "wallbox", "heat_pump", "mounting", "other",
    ]),
    discountBps: basisPointsSchema,
    lines: z.array(lineSchema).min(1).max(500),
  }).strip();
}

const publicTotalsViewSchema = z.object({
  basisNetCents: moneyCentsSchema,
  basisTaxCents: moneyCentsSchema,
  basisGrossCents: moneyCentsSchema,
  optionalNetCents: moneyCentsSchema,
  optionalTaxCents: moneyCentsSchema,
  optionalGrossCents: moneyCentsSchema,
}).strip();

function snapshotViewSchema(canReadPurchasePrice: boolean) {
  const lineSchema = canReadPurchasePrice ? purchaseLineViewSchema : publicLineViewSchema;

  return z.object({
    schemaVersion: z.literal("offer-variant-snapshot.v1"),
    workspaceId: snapshotUuidSchema,
    offerId: snapshotUuidSchema,
    variantId: snapshotUuidSchema,
    revision: positiveRevisionSchema,
    variantName: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000).nullable(),
    globalDiscountBps: basisPointsSchema,
    customDealNetCents: moneyCentsSchema.nullable(),
    contactContext: z.object({
      displayName: z.string().trim().min(1).max(200),
    }).strip(),
    installationSiteContext: z.object({
      formattedAddress: z.string().trim().min(1).max(360),
    }).strip(),
    currency: z.literal("EUR"),
    priceBasis: z.literal("net"),
    sections: z.array(sectionViewSchema(lineSchema)).min(1).max(25),
    totals: publicTotalsViewSchema,
  }).strip();
}

function projectOfferDetailView(
  view: OfferDetailViewModel,
  editorCapabilities: {
    canEditPrice: boolean;
    canApplyDiscount: boolean;
    canEditPurchasePrice: boolean;
    canGeneratePdf: boolean;
    canPrepareRelease: boolean;
    canApproveRelease: boolean;
  },
  recoveryScope: string,
  pdfDrafts: readonly OfferPdfDraftStatusResult[],
  releaseContext: {
    profile: CurrentOfferReleaseProfileResult | null;
    recipient: OfferRecipientRevisionResult | null;
    candidates: readonly OfferReleaseStatusResult[];
    validityWindow: ReleaseValidityWindow | null;
    showPanel: boolean;
  },
): OfferDetailSurfaceView {
  const activeVariantSchema = z.object({
    schemaVersion: z.literal("offer-variant-view.v1"),
    snapshot: snapshotViewSchema(view.permissions.canReadPurchasePrice),
  }).strip();
  const parsedVariant = activeVariantSchema.safeParse(view.activeVariant);
  if (!parsedVariant.success) {
    throw new Error("Angebotsansicht enthält einen ungültigen Datenstand");
  }

  const activeTabs = view.variants.filter((variant) => variant.active);
  const activeTab = activeTabs[0];
  const snapshot = parsedVariant.data.snapshot;
  if (
    activeTabs.length !== 1
    || !activeTab
    || snapshot.workspaceId !== view.workspaceId
    || snapshot.offerId !== view.offer.id
    || snapshot.variantId !== activeTab.id
    || snapshot.revision !== activeTab.revision
  ) {
    throw new Error("Angebotsansicht enthält widersprüchliche Variantenbindungen");
  }
  if (releaseContext.showPanel && releaseContext.validityWindow === null) {
    throw new Error("Der serverseitige Gültigkeitszeitraum fehlt");
  }

  return {
    state: view.state,
    workspaceId: view.workspaceId,
    recoveryScope,
    offer: {
      id: view.offer.id,
      projectId: view.offer.projectId,
      offerNumber: view.offer.offerNumber,
      status: view.offer.status,
      outdated: view.offer.outdated,
      forecastValueNetCents: view.offer.forecastValueNetCents,
    },
    variants: view.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      revision: variant.revision,
      active: variant.active,
      href: variant.href,
    })),
    activeVariant: parsedVariant.data,
    permissions: {
      canEdit: view.permissions.canEdit,
      canDuplicate: view.permissions.canDuplicate,
      canCreateBasis: view.permissions.canCreateBasis,
      canReadPurchasePrice: view.permissions.canReadPurchasePrice,
      canEditPrice: editorCapabilities.canEditPrice,
      canApplyDiscount: editorCapabilities.canApplyDiscount,
      canEditPurchasePrice: editorCapabilities.canEditPurchasePrice,
      canGeneratePdf: editorCapabilities.canGeneratePdf,
      canPrepareRelease: editorCapabilities.canPrepareRelease,
      canApproveRelease: editorCapabilities.canApproveRelease,
    },
    basisInput: view.permissions.canCreateBasis && view.newBasisInput ? {
      ...view.newBasisInput,
    } : undefined,
    actionState: { status: view.actionState.status },
    pdfDrafts: pdfDrafts.filter((draft) => (
      draft.variantId === snapshot.variantId
    )).map((draft) => ({
      jobId: draft.jobId,
      variantId: draft.variantId,
      variantRevision: draft.variantRevision,
      state: draft.state,
      attemptCount: draft.attemptCount,
      nextAttemptAt: draft.nextAttemptAt,
      createdAt: draft.createdAt,
      startedAt: draft.startedAt,
      finishedAt: draft.finishedAt,
      errorCode: draft.errorCode,
      canDownload: draft.canDownload,
    })),
    offerRelease: !releaseContext.showPanel ? undefined : {
      profile: releaseContext.profile?.active === null
        || releaseContext.profile?.active === undefined
        ? null
        : {
          profileId: releaseContext.profile.profileId,
          profileRevisionId: releaseContext.profile.active.profileRevisionId,
          revision: releaseContext.profile.active.profileRevision,
          profileName: releaseContext.profile.active.snapshot.profileName,
        },
      recipientPresence: releaseContext.recipient === null ? null : {
        revision: releaseContext.recipient.revision,
      },
      recipient: !editorCapabilities.canPrepareRelease
        || releaseContext.recipient === null ? null : {
        recipientRevisionId: releaseContext.recipient.recipientRevisionId,
        revision: releaseContext.recipient.revision,
        displayName: releaseContext.recipient.snapshot.displayName,
        company: releaseContext.recipient.snapshot.company,
        email: releaseContext.recipient.snapshot.email,
        billingAddress: releaseContext.recipient.snapshot.billingAddress,
      },
      sourcePdfDraftId: pdfDrafts.find((draft) => (
        draft.variantId === snapshot.variantId
        && draft.variantRevision === snapshot.revision
        && draft.state === "succeeded"
      ))?.jobId ?? null,
      validityWindow: releaseContext.validityWindow!,
      candidates: releaseContext.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        variantId: candidate.variantId,
        variantRevision: candidate.variantRevision,
        state: candidate.state,
        publicationStatus: candidate.publicationStatus,
        requiresZeroTaxReview: candidate.requiresZeroTaxReview,
        attemptCount: candidate.attemptCount,
        nextAttemptAt: candidate.nextAttemptAt,
        createdAt: candidate.createdAt,
        finishedAt: candidate.finishedAt,
        errorCode: candidate.errorCode,
        approvedAt: candidate.approval?.approvedAt ?? null,
        canDownload: candidate.canDownload,
        ...(candidate.approvalArtifactVersion === undefined
          ? {}
          : { approvalArtifactVersion: candidate.approvalArtifactVersion }),
      })),
    },
  };
}

export default async function OfferDetailPage(
  props: PageProps<"/w/[workspaceId]/angebote/[offerId]">,
) {
  const parsedParams = routeParamsSchema.safeParse(await props.params);
  if (!parsedParams.success) notFound();

  const query = await props.searchParams;
  const variante = query.variante;
  if (Array.isArray(variante)) notFound();
  const parsedVariant = variante === undefined ? null : variantUuidSchema.safeParse(variante);
  // Ein veralteter oder manuell veraenderter Varianten-Link darf nicht das
  // gesamte Offer verbergen. Nur eine gueltige UUID wird als Auswahl genutzt;
  // andernfalls greift das Readmodell deterministisch auf Variante 1 zurueck.
  const selectedVariantId = parsedVariant?.success ? parsedVariant.data : null;

  const { workspaceId, offerId } = parsedParams.data;
  let result: {
    view: Awaited<ReturnType<typeof getOfferDetail>>;
    pdfDrafts: OfferPdfDraftStatusResult[];
    releaseProfile: CurrentOfferReleaseProfileResult | null;
    releaseRecipient: OfferRecipientRevisionResult | null;
    releaseCandidates: OfferReleaseStatusResult[];
    releaseValidityWindow: ReleaseValidityWindow | null;
    showReleasePanel: boolean;
    recoveryScope: string;
    editorCapabilities: {
      canEditPrice: boolean;
      canApplyDiscount: boolean;
      canEditPurchasePrice: boolean;
      canGeneratePdf: boolean;
      canPrepareRelease: boolean;
      canApproveRelease: boolean;
    };
  };
  try {
    result = await authorizedQuery(
      workspaceId,
      "project.read",
      "offer_detail",
      async (tx, ctx) => {
        const view = await getOfferDetail(tx, ctx, {
          offerId,
          variantId: selectedVariantId,
        });
        const externalOnly = isExternalOnly(ctx);
        let releaseProfile: CurrentOfferReleaseProfileResult | null = null;
        let releaseRecipient: OfferRecipientRevisionResult | null = null;
        let releaseCandidates: OfferReleaseStatusResult[] = [];
        let releaseValidityWindow: ReleaseValidityWindow | null = null;
        if (view !== null && !externalOnly) {
          // authorizedQuery reicht genau einen transaktionsgebundenen pg-Client
          // durch. Dessen Queries muessen sequenziell bleiben; pg@9 weist
          // ueberlappende client.query()-Aufrufe nicht mehr nur als Warnung ab.
          const profileResult = await readCurrentOfferReleaseProfile(
            tx,
            ctx,
            { workspaceId },
          ).catch((error) => {
            if (error instanceof OfferReleaseProfileNotFoundError) return null;
            throw error;
          });
          const recipientResult = await readCurrentOfferRecipient(
            tx,
            ctx,
            { workspaceId, offerId },
          ).catch((error) => {
            if (error instanceof OfferReleaseProfileNotFoundError) return null;
            throw error;
          });
          const candidateResult = await listOfferReleaseCandidates(
            tx,
            ctx,
            { workspaceId, offerId },
          );
          const validityResult = await tx.execute<{
            min_valid_through: string;
            suggested_valid_through: string;
            max_valid_through: string;
            [key: string]: unknown;
          }>(sql`
            select
              to_char((statement_timestamp() at time zone 'Europe/Berlin')::date + 1, 'YYYY-MM-DD') as min_valid_through,
              to_char((statement_timestamp() at time zone 'Europe/Berlin')::date + 14, 'YYYY-MM-DD') as suggested_valid_through,
              to_char((statement_timestamp() at time zone 'Europe/Berlin')::date + 60, 'YYYY-MM-DD') as max_valid_through
          `);
          releaseProfile = profileResult;
          releaseRecipient = recipientResult;
          releaseCandidates = candidateResult;
          releaseValidityWindow = releaseValidityWindowSchema.parse({
            min: validityResult.rows[0]?.min_valid_through,
            suggested: validityResult.rows[0]?.suggested_valid_through,
            max: validityResult.rows[0]?.max_valid_through,
          });
        }
        return {
          view,
          pdfDrafts: view === null ? [] : await listOfferPdfDrafts(tx, ctx, {
            workspaceId,
            offerId,
          }),
          recoveryScope: offerRecoveryScope(workspaceId, ctx.actor),
          releaseProfile,
          releaseRecipient,
          releaseCandidates,
          releaseValidityWindow,
          showReleasePanel: !externalOnly,
          editorCapabilities: {
            canEditPrice: !externalOnly && can(ctx, "price.edit"),
            canApplyDiscount: !externalOnly && can(ctx, "discount.apply"),
            canEditPurchasePrice: !externalOnly
            && can(ctx, "price.edit")
            && can(ctx, "price.read_purchase"),
            canGeneratePdf: !externalOnly && can(ctx, "project.write"),
            canPrepareRelease: !externalOnly && can(ctx, "offer.release.prepare"),
            canApproveRelease: !externalOnly && can(ctx, "offer.release.approve"),
          },
        };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return (
        <OfferDetailView
          view={{
            state: "unauthenticated",
            workspaceId,
            actionState: { status: "unauthenticated" },
          }}
        />
      );
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Dieser Angebotsentwurf ist für dich nicht freigegeben." />;
    }
    throw error;
  }

  if (result.view === null) notFound();
  return (
    <OfferDetailView
      view={projectOfferDetailView(
        result.view,
        result.editorCapabilities,
        result.recoveryScope,
        result.pdfDrafts,
        {
          profile: result.releaseProfile,
          recipient: result.releaseRecipient,
          candidates: result.releaseCandidates,
          validityWindow: result.releaseValidityWindow,
          showPanel: result.showReleasePanel,
        },
      )}
    />
  );
}
