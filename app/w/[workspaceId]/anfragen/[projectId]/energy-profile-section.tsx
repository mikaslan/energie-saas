import Link from "next/link";
import type { ProjectEnergyContext } from "@/modules/energy";
import { DetailItem, Section } from "./_ui";
import { EnergyConfirmForm } from "./energy-confirm-form";

type Profile = NonNullable<ProjectEnergyContext["profile"]>["value"];

function knownValue(
  field: { status: "known"; value: unknown } | { status: "unknown" },
  unit?: string,
): string {
  if (field.status === "unknown") return "Unbekannt";
  const value = typeof field.value === "number"
    ? new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(field.value)
    : String(field.value);
  return unit ? `${value} ${unit}` : value;
}

function assetLabel(asset: Profile["existingAssets"][keyof Profile["existingAssets"]]): string {
  if (asset.status === "known_present") return "Vorhanden";
  if (asset.status === "known_absent") return "Nicht vorhanden";
  return "Unbekannt";
}

function profileState(context: ProjectEnergyContext):
  "no_profile" | "draft" | "confirmed" | "address_drift" | "read_only" {
  if (!context.capabilities.canEdit) return "read_only";
  if (context.profile === null) return "no_profile";
  if (context.profile.addressRevision !== context.addressRevision) return "address_drift";
  return context.profile.confirmed ? "confirmed" : "draft";
}

function profileStateLabel(state: ReturnType<typeof profileState>): string {
  if (state === "no_profile") return "Noch kein Profil";
  if (state === "draft") return "Entwurf – noch nicht bestätigt";
  if (state === "confirmed") return "Für diese Revision bestätigt";
  if (state === "address_drift") return "Adresse geändert – erneute Prüfung nötig";
  return "Nur Lesezugriff";
}

export function needsEnergyConfirmation(context: ProjectEnergyContext): boolean {
  if (context.profile === null) return false;
  if (!context.profile.confirmed) return true;
  if (context.calculation.status === "stale") return true;
  return context.calculation.status === "blocked"
    && context.calculation.blocker === "calculation";
}

function confirmationBlocker(context: ProjectEnergyContext): string {
  if (!context.capabilities.canEdit) {
    return "Mit deinem Lesezugriff kannst du Profil und Ergebnis ansehen, aber nicht verändern.";
  }
  if (context.profile === null) return "Speichere zuerst ein Energieprofil.";
  if (context.profile.addressRevision !== context.addressRevision) {
    return "Die Profilrevision gehört zu einer älteren Adresse und muss neu gespeichert werden.";
  }
  if (context.profile.value.roofs.some((roof) => roof.source === "default")) {
    return "Ein Default-Dach ist keine hausbezogene Dachwahrheit. Erfasse im Editor eine neue Ersatzgeometrie.";
  }
  if (context.profile.value.roofs.some((roof) => roof.source !== "operator_reviewed")) {
    return "Prüfe jedes Dach im Editor bewusst für den aktuellen Standort.";
  }
  if (context.profile.value.roofs.some((roof) => roof.shading.status === "unknown")) {
    return "Erfasse für jede Dachfläche eine geprüfte Verschattung; unbekannt reicht für die Engine nicht aus.";
  }
  if (
    context.calculation.status === "blocked"
    && context.calculation.blocker === "address_pin"
  ) {
    return "Bestätige zuerst die aktuelle Hausadresse und den Planungs-Pin.";
  }
  if (
    context.calculation.status === "blocked"
    && context.calculation.blocker === "project_requirement"
  ) {
    return "Die Projektanforderungen sind noch unvollständig oder passen nicht zum Profil.";
  }
  return "Die Serviceschicht gibt die Bestätigung für diesen Stand noch nicht frei.";
}

export function EnergyProfileSection({
  workspaceId,
  projectId,
  context,
}: {
  workspaceId: string;
  projectId: string;
  context: ProjectEnergyContext | null;
}) {
  if (context === null) {
    return (
      <Section
        title="Energieprofil"
        intro="Revisionsgebundene Eingaben für die serverseitige Planungsrechnung."
      >
        <div
          data-energy-profile-state="no_profile"
          className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        >
          Für dieses Projekt ist noch kein verlässliches Energie-Readmodel verfügbar.
        </div>
      </Section>
    );
  }

  const state = profileState(context);
  const profile = context.profile;
  const editorPath = `/w/${workspaceId}/anfragen/${projectId}/energieprofil`;
  const needsConfirmation = needsEnergyConfirmation(context);

  return (
    <Section
      title="Energieprofil"
      intro="Rechner-Eingaben werden als prüfbarer Entwurf übernommen. Speichern und Bestätigen sind zwei getrennte Vertrauensstufen."
    >
      <div data-energy-profile-state={state}>
        <div
          className={
            state === "confirmed"
              ? "mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-950"
              : "mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950"
          }
        >
          Profilstatus: {profileStateLabel(state)}
        </div>

        {profile === null ? (
          <p className="text-sm leading-6 text-slate-600">
            Die importierten Rechner-Eingaben sind noch nicht als operative
            Profilrevision gespeichert.
          </p>
        ) : (
          <dl>
            <DetailItem term="Quelle">
              Importierte Rechner-Eingaben, fachlich prüfbar
            </DetailItem>
            <DetailItem term="Profilrevision" numeric>{profile.revision}</DetailItem>
            <DetailItem term="Adressrevision" numeric>{profile.addressRevision}</DetailItem>
            <DetailItem term="Haushaltsverbrauch" numeric>
              {knownValue(profile.value.consumption.householdKwhPerYear, "kWh/Jahr")}
            </DetailItem>
            <DetailItem term="Dachflächen" numeric>{profile.value.roofs.length}</DetailItem>
            <DetailItem term="Bestands-PV">
              {assetLabel(profile.value.existingAssets.pv)}
            </DetailItem>
            <DetailItem term="Bestandsspeicher">
              {assetLabel(profile.value.existingAssets.storage)}
            </DetailItem>
          </dl>
        )}

        {context.capabilities.canEdit ? (
          <Link
            href={editorPath}
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-md border border-blue-700 bg-white px-4 py-2.5 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 sm:w-auto"
          >
            {profile === null ? "Energieprofil anlegen" : "Energieprofil prüfen und bearbeiten"}
          </Link>
        ) : null}

        {profile !== null && needsConfirmation ? (
          <div className="mt-5 border-t border-slate-200 pt-5">
            {profile.confirmed ? (
              <p className="mb-3 text-sm leading-6 text-slate-600">
                Das Profil ist bestätigt, aber die aktuelle Planung ist nicht
                mehr daran gebunden. Prüfe die sichtbaren Revisionen und
                bestätige diese Bindung erneut.
              </p>
            ) : null}
            {context.capabilities.canConfirm ? (
              <EnergyConfirmForm
                workspaceId={workspaceId}
                projectId={projectId}
                addressRevision={context.addressRevision}
                profileRevision={profile.revision}
              />
            ) : (
              <div
                role="note"
                className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
              >
                <span className="font-semibold">Bestätigung blockiert: </span>
                {confirmationBlocker(context)}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </Section>
  );
}
