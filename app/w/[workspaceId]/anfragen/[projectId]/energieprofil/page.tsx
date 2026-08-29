import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  EnergyProfileInvalidError,
  EnergyProfileUnsupportedSourceError,
  getProjectEnergyContext,
  getProjectEnergyProfileCandidate,
  type ProjectEnergyContext,
  type ProjectEnergyProfileCandidate,
} from "@/modules/energy";
import { DeniedState, Section } from "../_ui";
import { EnergyConfirmForm } from "../energy-confirm-form";
import { needsEnergyConfirmation } from "../energy-profile-section";
import { EnergyProfileEditor } from "./energy-profile-editor";

export const metadata: Metadata = {
  title: "Energieprofil | Energie-SaaS",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

type ContextLoad =
  | { kind: "loaded"; context: ProjectEnergyContext | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

type CandidateLoad =
  | { kind: "loaded"; candidate: ProjectEnergyProfileCandidate | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
  | { kind: "unsupported" }
  | { kind: "invalid" };

async function loadContext(workspaceId: string, projectId: string): Promise<ContextLoad> {
  try {
    const context = await authorizedQuery(
      workspaceId,
      "project.read",
      "energy_profile",
      (tx, ctx) => getProjectEnergyContext(tx, ctx, projectId),
    );
    return { kind: "loaded", context };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadCandidate(
  workspaceId: string,
  projectId: string,
): Promise<CandidateLoad> {
  try {
    const candidate = await authorizedQuery(
      workspaceId,
      "project.write",
      "energy_profile",
      (tx, ctx) => getProjectEnergyProfileCandidate(tx, ctx, projectId),
    );
    return { kind: "loaded", candidate };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    if (error instanceof EnergyProfileUnsupportedSourceError) return { kind: "unsupported" };
    if (error instanceof EnergyProfileInvalidError) return { kind: "invalid" };
    throw error;
  }
}

function saveBlocker(context: ProjectEnergyContext): string | null {
  if (
    context.calculation.status === "blocked"
    && context.calculation.blocker === "address_pin"
  ) {
    return "Bestätige in der Projektakte zuerst eine hausgenaue Adresse und den aktuellen Planungs-Pin.";
  }
  return null;
}

function confirmationBlocker(context: ProjectEnergyContext): string {
  const profile = context.profile;
  if (profile === null) return "Speichere zuerst eine aktuelle Profilrevision.";
  if (profile.addressRevision !== context.addressRevision) {
    return "Das Profil gehört zu einer älteren Adressrevision und muss neu geprüft werden.";
  }
  if (profile.value.roofs.some((roof) => roof.source === "default")) {
    return "Ersetze jedes Default-Dach durch eine bewusst neu erfasste Geometrie.";
  }
  if (profile.value.roofs.some((roof) => roof.source !== "operator_reviewed")) {
    return "Markiere jede Dachfläche erst nach bewusster Standortprüfung als geprüft.";
  }
  if (profile.value.roofs.some((roof) => roof.shading.status === "unknown")) {
    return "Erfasse für jede Dachfläche eine geprüfte Verschattung.";
  }
  if (
    context.calculation.status === "blocked"
    && context.calculation.blocker === "project_requirement"
  ) {
    return "Die aktuellen Projektanforderungen passen noch nicht vollständig zum Profil.";
  }
  return "Adresse, Profil oder Projektanforderungen erfüllen die Bestätigungsvoraussetzungen noch nicht.";
}

export default async function EnergyProfilePage({
  params,
}: PageProps<"/w/[workspaceId]/anfragen/[projectId]/energieprofil">) {
  const parsedParams = routeParamsSchema.safeParse(await params);
  if (!parsedParams.success) notFound();
  const { workspaceId, projectId } = parsedParams.data;
  const projectPath = `/w/${workspaceId}/anfragen/${projectId}`;
  const editorPath = `${projectPath}/energieprofil`;

  const contextResult = await loadContext(workspaceId, projectId);
  if (contextResult.kind === "unauthenticated") {
    redirect(`/login?next=${encodeURIComponent(editorPath)}`);
  }
  if (contextResult.kind === "denied") return <DeniedState />;
  if (contextResult.context === null) notFound();
  const context = contextResult.context;

  let candidateResult: CandidateLoad | null = null;
  if (context.capabilities.canEdit) {
    candidateResult = await loadCandidate(workspaceId, projectId);
    if (candidateResult.kind === "unauthenticated") {
      redirect(`/login?next=${encodeURIComponent(editorPath)}`);
    }
    if (candidateResult.kind === "denied") return <DeniedState />;
  }

  const candidate = candidateResult?.kind === "loaded"
    ? candidateResult.candidate
    : null;
  const baseProfile = context.profile?.value ?? candidate?.profile ?? null;
  const expectedLatestRevision = context.profile?.revision
    ?? candidate?.expectedLatestRevision
    ?? 0;
  const needsConfirmation = needsEnergyConfirmation(context);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Brotkrumen" className="mb-6 flex items-start justify-between gap-4">
          <Link
            href={projectPath}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true" className="mr-2">←</span>
            Zurück zur Projektakte
          </Link>
          <SignOutButton />
        </nav>

        <header className="mb-8 border-b border-slate-200 pb-7">
          <p className="text-sm font-semibold text-blue-700">Projektakte</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
            Energieprofil prüfen
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Speichere eine revisionsgebundene Profilwahrheit und bestätige sie
            anschließend in einer zweiten, bewussten Aktion.
          </p>
        </header>

        <div className="grid min-w-0 gap-6">
          {!context.capabilities.canEdit ? (
            <Section title="Nur Lesezugriff">
              <p className="text-sm leading-6 text-slate-600">
                Du kannst das Energieprofil in der Projektakte ansehen, aber
                weder speichern noch bestätigen.
              </p>
            </Section>
          ) : candidateResult?.kind === "unsupported" ? (
            <Section title="Energieprofil blockiert">
              <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
                Die Rechnerquelle hat eine nicht unterstützte Version. Es wird
                kein Profil aus unsicheren Feldern erzeugt.
              </div>
            </Section>
          ) : candidateResult?.kind === "invalid" ? (
            <Section title="Energieprofil blockiert">
              <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
                Die Rechner-Eingaben sind nicht konsistent genug für ein
                verlässliches Energieprofil.
              </div>
            </Section>
          ) : baseProfile && candidate ? (
            <Section
              title="Profilfelder"
              intro={`Aktuelle Adressrevision ${context.addressRevision}; erwartete Profilrevision ${expectedLatestRevision}.`}
            >
              <EnergyProfileEditor
                workspaceId={workspaceId}
                projectId={projectId}
                addressRevision={context.addressRevision}
                expectedLatestRevision={expectedLatestRevision}
                profile={baseProfile}
                saveBlockedReason={saveBlocker(context)}
              />
            </Section>
          ) : (
            <Section title="Energieprofil blockiert">
              <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
                Für dieses Projekt ist keine unterstützte Rechner-Kandidatur verfügbar.
              </div>
            </Section>
          )}

          {context.capabilities.canEdit && context.profile !== null ? (
            <Section
              title="Eingaben getrennt bestätigen"
              intro="Die Bestätigung verändert keine Profilwerte; sie bindet genau die sichtbare Profil- und Adressrevision."
            >
              {!needsConfirmation ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-950">
                  Profilrevision {context.profile.revision} ist für
                  Adressrevision {context.profile.addressRevision} bestätigt.
                </p>
              ) : context.capabilities.canConfirm ? (
                <div className="grid gap-3">
                  {context.profile.confirmed ? (
                    <p className="text-sm leading-6 text-slate-600">
                      Das Profil ist bereits bestätigt. Weil die aktuelle
                      Planung nicht mehr daran gebunden ist, braucht die neue
                      Revisionsbindung eine erneute bewusste Bestätigung.
                    </p>
                  ) : null}
                  <EnergyConfirmForm
                    workspaceId={workspaceId}
                    projectId={projectId}
                    addressRevision={context.addressRevision}
                    profileRevision={context.profile.revision}
                  />
                </div>
              ) : (
                <div role="note" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
                  <span className="font-semibold">Bestätigung blockiert: </span>
                  {confirmationBlocker(context)}
                </div>
              )}
            </Section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
