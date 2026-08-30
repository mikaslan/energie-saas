import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  OfferReleaseProfileNotFoundError,
  readCurrentOfferReleaseProfile,
} from "@/modules/offers";
import { DeniedState } from "../../anfragen/[projectId]/_ui";
import {
  OfferReleaseProfileForm,
  type OfferReleaseProfileSurface,
} from "./offer-release-profile-form";

export const metadata: Metadata = {
  title: "Angebotsprofile | WMEE Vertrieb",
};

const paramsSchema = z.strictObject({
  workspaceId: z.uuid().transform((value) => value.toLowerCase()),
});

export default async function OfferReleaseProfilesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/angebotsprofile">,
) {
  const parsed = paramsSchema.safeParse(await props.params);
  if (!parsed.success) notFound();
  const { workspaceId } = parsed.data;

  let result: { profile: OfferReleaseProfileSurface | null; canManage: boolean };
  try {
    result = await authorizedQuery(
      workspaceId,
      "project.read",
      "offer_release_profile_settings",
      async (tx, ctx) => {
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError(
            "project.read",
            "offer_release_profile_settings",
            "external_only_without_assignment",
            ctx.actor,
          );
        }
        let profile: OfferReleaseProfileSurface | null = null;
        try {
          const current = await readCurrentOfferReleaseProfile(tx, ctx, { workspaceId });
          profile = {
            profileId: current.profileId,
            currentRevision: current.currentRevision,
            current: {
              profileRevisionId: current.current.profileRevisionId,
              profileName: current.current.profileName,
              sender: {
                legalName: current.current.sender.legalName,
                tradingName: current.current.sender.tradingName,
                representedBy: current.current.sender.representedBy,
                address: {
                  street: current.current.sender.address.street,
                  houseNumber: current.current.sender.address.houseNumber,
                  postalCode: current.current.sender.address.postalCode,
                  city: current.current.sender.address.city,
                  country: current.current.sender.address.country,
                },
                email: current.current.sender.email,
                phoneE164: current.current.sender.phoneE164,
                websiteHttpsUrl: current.current.sender.websiteHttpsUrl,
                registerCourt: current.current.sender.registerCourt,
                registerNumber: current.current.sender.registerNumber,
                vatId: current.current.sender.vatId,
              },
              legalDocuments: {
                terms: { ...current.current.legalDocuments.terms },
                withdrawalInformation: {
                  ...current.current.legalDocuments.withdrawalInformation,
                },
                privacyNotice: { ...current.current.legalDocuments.privacyNotice },
              },
            },
            active: current.active === null ? null : {
              profileRevisionId: current.active.profileRevisionId,
              profileRevision: current.active.profileRevision,
              reviewedAt: current.active.reviewedAt,
            },
          };
        } catch (error) {
          if (!(error instanceof OfferReleaseProfileNotFoundError)) throw error;
        }
        return { profile, canManage: can(ctx, "settings.manage") };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return (
        <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-6">
            <h1 className="text-2xl font-semibold text-slate-950">Anmeldung erforderlich</h1>
            <p className="mt-2 text-sm leading-6 text-slate-700">Melde dich erneut an, um die Angebotsprofile zu öffnen.</p>
            <Link href="/login" className="mt-5 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Zum Login</Link>
          </section>
        </main>
      );
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Angebotsprofile sind für dich nicht freigegeben." />;
    }
    throw error;
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-950 sm:px-6 lg:px-8">
      <a href="#offer-profile-main" className="sr-only rounded bg-white px-3 py-2 font-semibold focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:ring-2 focus:ring-blue-600">Zum Angebotsprofil springen</a>
      <div id="offer-profile-main" className="mx-auto w-full max-w-5xl">
        <nav aria-label="Brotkrumen">
          <Link href={`/w/${workspaceId}/angebote`} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">← Zur Angebotsübersicht</Link>
        </nav>
        <header className="mb-6 mt-4 border-b border-slate-200 pb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Einstellungen</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Angebotsprofile</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700">
            Versionierte Ausstellerdaten und Rechtstexte für Freigabekandidaten. Jeder Stand bleibt nachvollziehbar; Aktivieren ist eine getrennte Prüfung.
          </p>
        </header>
        <OfferReleaseProfileForm
          workspaceId={workspaceId}
          profile={result.profile}
          canManage={result.canManage}
        />
      </div>
    </main>
  );
}
