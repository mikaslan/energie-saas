import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import { listDedupeQueue, type DedupeEntity, type DedupeQueueEntry } from "@/modules/dedupe";

const workspaceIdSchema = z.uuid();

export const metadata: Metadata = {
  title: "Dubletten | WMEE Vertrieb",
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

function entitySegment(entity: DedupeEntity): "kontakt" | "projekt" {
  return entity === "contact" ? "kontakt" : "projekt";
}

function entityLabel(entity: DedupeEntity): string {
  return entity === "contact" ? "Kontakt" : "Anfrage";
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

function QueueRow({ entry, workspaceId }: { entry: DedupeQueueEntry; workspaceId: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">{entry.displayName}</p>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {entityLabel(entry.entity)}
          {" · "}
          {entry.contactName}
          {entry.email ? ` · ${entry.email}` : ""}
          {entry.phone ? ` · ${entry.phone}` : ""}
          {entry.sourceKey ? ` · Quelle ${entry.sourceKey}` : ""}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {entry.candidateCount === 1
            ? "1 möglicher Zwilling"
            : `${entry.candidateCount} mögliche Zwillinge`}
          {" · markiert "}
          {formatDate(entry.flaggedAt)}
        </p>
      </div>
      <Link
        href={`/w/${workspaceId}/dubletten/${entitySegment(entry.entity)}/${entry.id}`}
        className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
      >
        Prüfen
      </Link>
    </li>
  );
}

export default async function DublettenPage({
  params,
  searchParams,
}: PageProps<"/w/[workspaceId]/dubletten">) {
  const { workspaceId } = await params;
  const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) notFound();
  const validWorkspaceId = parsedWorkspaceId.data;

  // Filter (?typ=kontakt|projekt, ?quelle=…, ?q=…). Unbekannte Werte
  // brechen fail-closed ab — kein stiller Alle-Fallback.
  const query = await searchParams;
  const rawEntity = query?.typ;
  const entityValue = Array.isArray(rawEntity) ? rawEntity[0] : rawEntity;
  let entity: DedupeEntity | undefined;
  if (entityValue !== undefined) {
    if (entityValue === "kontakt") entity = "contact";
    else if (entityValue === "projekt") entity = "project";
    else notFound();
  }
  const rawSource = query?.quelle;
  const sourceValue = Array.isArray(rawSource) ? rawSource[0] : rawSource;
  if (sourceValue !== undefined && (sourceValue.length === 0 || sourceValue.length > 80)) {
    notFound();
  }
  const rawQ = query?.q;
  const qValue = Array.isArray(rawQ) ? rawQ[0] : rawQ;
  if (qValue !== undefined && qValue.length > 200) notFound();
  const sourceKey = sourceValue === undefined || sourceValue.trim().length === 0
    ? undefined
    : sourceValue.trim();
  const q = qValue === undefined || qValue.trim().length === 0 ? undefined : qValue.trim();

  let entries: DedupeQueueEntry[] | undefined;
  let unauthenticated = false;
  let denied = false;
  try {
    entries = await authorizedQuery(
      validWorkspaceId,
      "contact.read",
      "dedupe_queue",
      (tx, ctx) => {
        // F1-22: Triage ist internen Mitgliedern vorbehalten (S7: Extern 403).
        // authorizedQuery prüft die Action nicht selbst (nur Audit-Label).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError("contact.read", "dedupe_queue", undefined, ctx.actor);
        }
        return listDedupeQueue(tx, ctx, { entity, sourceKey, q });
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) unauthenticated = true;
    else if (error instanceof PermissionDeniedError) denied = true;
    else throw error;
  }

  const queuePath = `/w/${validWorkspaceId}/dubletten`;
  if (unauthenticated) {
    redirect(`/login?${new URLSearchParams({ next: queuePath }).toString()}`);
  }
  if (denied) return <AccessDenied />;
  if (!entries) throw new Error("Dubletten-Queue konnte nicht geladen werden");

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-brand-700 text-sm font-bold text-white" aria-hidden="true">
              W
            </span>
            <div>
              <p className="text-sm font-semibold leading-5">WMEE Vertrieb</p>
              <h1 className="text-xl font-semibold leading-6">Dubletten</h1>
            </div>
          </div>
          <Link
            href={`/w/${validWorkspaceId}/anfragen`}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
          >
            Zurück zu Anfragen
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
        <form method="get" className="flex flex-wrap items-end gap-3" data-testid="dubletten-filter">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Typ
            <select
              name="typ"
              defaultValue={entity === "contact" ? "kontakt" : entity === "project" ? "projekt" : ""}
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-600"
            >
              <option value="">Alle</option>
              <option value="kontakt">Kontakt</option>
              <option value="projekt">Anfrage</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Quelle
            <input
              name="quelle"
              defaultValue={sourceKey ?? ""}
              maxLength={80}
              placeholder="z. B. manual"
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-600"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Suche
            <input
              name="q"
              defaultValue={q ?? ""}
              maxLength={200}
              placeholder="Name, E-Mail, Telefon"
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-600"
            />
          </label>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
          >
            Filtern
          </button>
        </form>

        <section
          aria-label="Dubletten-Queue"
          className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
        >
          {entries.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-600" data-testid="dubletten-empty">
              Keine Dubletten — alle Prüfhinweise sind abgearbeitet.
            </p>
          ) : (
            <ul data-testid="dubletten-queue">
              {entries.map((entry) => (
                <QueueRow key={`${entry.entity}:${entry.id}`} entry={entry} workspaceId={validWorkspaceId} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
