import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  DedupeNotFoundError,
  getDedupeDetail,
  type DedupeCandidate,
  type DedupeDetail,
  type DedupeEntity,
} from "@/modules/dedupe";
import { LinkCandidateForm, MarkReviewedForm } from "./detail-actions";

const workspaceIdSchema = z.uuid();
const idSchema = z.uuid();

export const metadata: Metadata = {
  title: "Dublette prüfen | WMEE Vertrieb",
};

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormatter.format(date);
}

function AccessDenied() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-6 py-16">
      <section className="w-full rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">WMEE Vertrieb</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">Kein Zugriff</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600" data-testid="dubletten-denied">
          Die Dubletten-Triage ist internen Mitgliedern vorbehalten.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
        >
          Zur Startseite
        </Link>
      </section>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900">{value}</dd>
    </div>
  );
}

const FALLBACK = "—";

function CandidateCard({
  candidate,
  workspaceId,
  projectId,
  canLink,
}: {
  candidate: DedupeCandidate;
  workspaceId: string;
  projectId: string | null;
  canLink: boolean;
}) {
  const matches: string[] = [];
  if (candidate.matchEmail) matches.push("E-Mail");
  if (candidate.matchPhone) matches.push("Telefon");
  return (
    <li className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <p className="text-sm font-semibold text-slate-900">{candidate.displayName}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {candidate.email ?? FALLBACK}
          {" · "}
          {candidate.phone ?? FALLBACK}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Übereinstimmung: {matches.length > 0 ? matches.join(" + ") : FALLBACK}
          {candidate.flagged ? " · selbst zur Prüfung markiert" : ""}
          {" · angelegt "}
          {formatDate(candidate.createdAt)}
        </p>
      </div>
      {projectId !== null && canLink ? (
        <LinkCandidateForm
          workspaceId={workspaceId}
          projectId={projectId}
          candidateId={candidate.id}
          candidateName={candidate.displayName}
        />
      ) : null}
    </li>
  );
}

function DetailSubject({ detail }: { detail: DedupeDetail }) {
  if (detail.entity === "contact") {
    const subject = detail.subject;
    const address = [subject.street, subject.houseNumber].filter(Boolean).join(" ");
    const city = [subject.postalCode, subject.city].filter(Boolean).join(" ");
    return (
      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" value={subject.displayName} />
        <Field label="E-Mail" value={subject.email ?? FALLBACK} />
        <Field label="Telefon" value={subject.phoneE164 ?? subject.phoneMobile ?? subject.phoneRaw ?? FALLBACK} />
        <Field label="Adresse" value={[address, city].filter(Boolean).join(", ") || FALLBACK} />
        <Field label="Markiert" value={formatDate(subject.flaggedAt)} />
      </dl>
    );
  }
  const subject = detail.subject;
  const address = [subject.site.street, subject.site.houseNumber].filter(Boolean).join(" ");
  const city = [subject.site.postalCode, subject.site.city].filter(Boolean).join(" ");
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <Field label="Anfrage" value={subject.name} />
      <Field label="Quelle" value={subject.sourceKey} />
      <Field label="Aktueller Kontakt" value={subject.contact.displayName} />
      <Field
        label="Kontakt-Erreichbarkeit"
        value={[subject.contact.email, subject.contact.phone].filter(Boolean).join(" · ") || FALLBACK}
      />
      <Field
        label="Standort"
        value={subject.site.formattedAddress || [address, city].filter(Boolean).join(", ") || FALLBACK}
      />
      <Field label="Markiert" value={formatDate(subject.flaggedAt)} />
    </dl>
  );
}

export default async function DublettenDetailPage({
  params,
}: PageProps<"/w/[workspaceId]/dubletten/[entity]/[id]">) {
  const { workspaceId, entity: entitySegment, id } = await params;
  const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) notFound();
  const validWorkspaceId = parsedWorkspaceId.data;

  let entity: DedupeEntity;
  if (entitySegment === "kontakt") entity = "contact";
  else if (entitySegment === "projekt") entity = "project";
  else notFound();
  if (!idSchema.safeParse(id).success) notFound();

  const detailPath = `/w/${validWorkspaceId}/dubletten/${entitySegment}/${id}`;
  let detail: DedupeDetail | undefined;
  let unauthenticated = false;
  let denied = false;
  let missing = false;
  try {
    detail = await authorizedQuery(
      validWorkspaceId,
      "contact.read",
      "dedupe_detail",
      (tx, ctx) => {
        // F1-22: Triage ist internen Mitgliedern vorbehalten (S7: Extern 403).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError("contact.read", "dedupe_detail", undefined, ctx.actor);
        }
        return getDedupeDetail(tx, ctx, { entity, id });
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) unauthenticated = true;
    else if (error instanceof PermissionDeniedError) denied = true;
    else if (error instanceof DedupeNotFoundError) missing = true;
    else throw error;
  }

  if (unauthenticated) {
    redirect(`/login?${new URLSearchParams({ next: detailPath }).toString()}`);
  }
  if (denied) return <AccessDenied />;
  if (missing) notFound();
  if (!detail) throw new Error("Dubletten-Detail konnte nicht geladen werden");

  const title = detail.entity === "contact" ? "Kontakt prüfen" : "Anfrage prüfen";
  const readOnly = !detail.permissions.canMarkReviewed && !detail.permissions.canLink;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-brand-700 text-sm font-bold text-white" aria-hidden="true">
              W
            </span>
            <div>
              <p className="text-sm font-semibold leading-5">WMEE Vertrieb · Dubletten</p>
              <h1 className="text-xl font-semibold leading-6">{title}</h1>
            </div>
          </div>
          <Link
            href={`/w/${validWorkspaceId}/dubletten`}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
          >
            Zurück zur Queue
          </Link>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-6 sm:px-6" data-testid="dedupe-detail">
        <section aria-label="Geprüfter Eintrag" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <DetailSubject detail={detail} />
        </section>

        {readOnly ? (
          <p className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="dedupe-readonly">
            Du kannst die Dubletten sehen, aber nicht verändern.
          </p>
        ) : (
          <section aria-label="Aktionen" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Kein Dublette — Hinweis auflösen</h2>
            <p className="mt-1 text-sm text-slate-600">
              Markiert den Eintrag als geprüft. Es wird nichts zusammengeführt oder gelöscht.
            </p>
            <div className="mt-3">
              <MarkReviewedForm
                workspaceId={validWorkspaceId}
                entity={detail.entity}
                id={detail.entity === "contact" ? detail.subject.id : detail.subject.id}
                expectedRevision={detail.entity === "contact" ? detail.subject.revision : undefined}
              />
            </div>
          </section>
        )}

        <section aria-label="Mögliche Zwillinge">
          <h2 className="text-sm font-semibold text-slate-900">
            Mögliche Zwillinge ({detail.candidates.length})
          </h2>
          {detail.candidates.length === 0 ? (
            <p className="mt-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600" data-testid="dedupe-candidates-empty">
              Keine Kandidaten mit gleicher E-Mail oder Telefonnummer.
            </p>
          ) : (
            <ul className="mt-2 grid gap-3" data-testid="dedupe-candidates">
              {detail.candidates.map((candidate) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  workspaceId={validWorkspaceId}
                  projectId={detail.entity === "project" ? detail.subject.id : null}
                  canLink={detail.entity === "project" && detail.permissions.canLink}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
