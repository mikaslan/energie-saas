import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { CreateDocumentDialog } from "./create-document-dialog";
import { DocumentRowActions } from "./document-row-actions";
import {
  CREDIT_NOTE_TYPE_LABELS,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPE_SINGULAR_LABELS,
  PAYMENT_STATUS_LABELS,
  formatBerlinDate,
  formatDateOnly,
  formatEuro,
} from "../labels";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  commercialDocumentTypes,
  type CommercialDocumentType,
} from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import { listDocumentGroups, listDocuments } from "@/modules/invoicing";
import { DeniedState } from "../../_ui";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const typeSchema = z.enum(commercialDocumentTypes);
const cursorPattern = /^[A-Za-z0-9_-]{1,256}$/u;

const filterSchema = z.object({
  status: z.enum(["draft", "issued", "voided"]).optional(),
  zahlung: z.enum(["unpaid", "partially_paid", "paid", "overdue", "uncollectable"]).optional(),
  von: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  bis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  fdatumVon: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  fdatumBis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  grund: z.enum(["minderleistung", "empfehlungspraemie"]).optional(),
  archiv: z.enum(["active", "archived", "all"]).optional(),
  suche: z.string().max(160).optional(),
  cursor: z.string().regex(cursorPattern).optional(),
});

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// Leere Formularwerte (GET-Formulare senden "feld=") gelten als fehlend —
// sonst würde die regex-Validierung den ganzen Filtersatz verwerfen.
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function buildFilterQuery(filters: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

// Typ-spezifische Datums-Spalte laut Spec §7 (Anzeige).
function typeDateField(document: {
  dueDate: string | null;
  deliveryDate: string | null;
  validityDate: string | null;
  plannedDeliveryDate: string | null;
  plannedServiceDate: string | null;
}, type: CommercialDocumentType): { label: string; value: string | null } {
  switch (type) {
    case "invoice": return { label: "Fällig", value: document.dueDate };
    case "credit_note":
    case "delivery_note": return { label: "Lieferdatum", value: document.deliveryDate };
    case "order_confirmation": return {
      label: "Geplante Lieferung",
      value: document.plannedDeliveryDate,
    };
    case "purchase_order":
    case "letter": return { label: "Gültig bis", value: document.validityDate };
  }
}

const moneyTypes: CommercialDocumentType[] = ["invoice", "credit_note"];

const inputClass =
  "mt-1 min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";

function activeFilterCount(filters: z.infer<typeof filterSchema>): number {
  return [
    filters.status, filters.zahlung, filters.von, filters.bis,
    filters.fdatumVon, filters.fdatumBis, filters.grund, filters.archiv,
    filters.suche,
  ].filter((value) => value !== undefined && value !== "").length;
}

export default async function InvoicingDocumentListPage(
  props: PageProps<"/w/[workspaceId]/rechnungen/[type]">,
) {
  const params = await props.params;
  const parsedWorkspace = workspaceIdSchema.safeParse(params.workspaceId);
  const parsedType = typeSchema.safeParse(params.type);
  if (!parsedWorkspace.success || !parsedType.success) notFound();
  const workspaceId = parsedWorkspace.data;
  const type = parsedType.data;

  const rawSearch = await props.searchParams;
  const parsedFilters = filterSchema.safeParse({
    status: nonEmpty(firstQueryValue(rawSearch.status)),
    zahlung: nonEmpty(firstQueryValue(rawSearch.zahlung)),
    von: nonEmpty(firstQueryValue(rawSearch.von)),
    bis: nonEmpty(firstQueryValue(rawSearch.bis)),
    fdatumVon: nonEmpty(firstQueryValue(rawSearch.fdatumVon)),
    fdatumBis: nonEmpty(firstQueryValue(rawSearch.fdatumBis)),
    grund: nonEmpty(firstQueryValue(rawSearch.grund)),
    archiv: nonEmpty(firstQueryValue(rawSearch.archiv)),
    suche: nonEmpty(firstQueryValue(rawSearch.suche)),
    cursor: nonEmpty(firstQueryValue(rawSearch.cursor)),
  });
  const filters = parsedFilters.success ? parsedFilters.data : {};

  const list = await (async () => {
    try {
      return await authorizedQuery(
        workspaceId,
        "invoicing.read",
        "commercial_document_list",
        (tx, ctx) => listDocuments(tx, ctx, {
          schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
          type,
          filters: {
            status: filters.status,
            paymentStatus: filters.zahlung,
            issuedFrom: filters.von,
            issuedTo: filters.bis,
            typeDateFrom: filters.fdatumVon,
            typeDateTo: filters.fdatumBis,
            creditNoteType: filters.grund,
            archived: filters.archiv,
            search: filters.suche,
          },
          cursor: filters.cursor,
        }),
      );
    } catch (error) {
      if (error instanceof NotAuthenticatedError) {
        redirect(`/login?${new URLSearchParams({ next: `/w/${workspaceId}/rechnungen/${type}` }).toString()}`);
      }
      if (error instanceof PermissionDeniedError) {
        return null;
      }
      throw error;
    }
  })();

  const groups = await (async () => {
    try {
      return await authorizedQuery(
        workspaceId,
        "invoicing.read",
        "commercial_document_group_list",
        (tx, ctx) => listDocumentGroups(tx, ctx),
      );
    } catch (error) {
      if (error instanceof NotAuthenticatedError || error instanceof PermissionDeniedError) {
        return [];
      }
      throw error;
    }
  })();

  if (!list) {
    return <DeniedState title={`Die ${DOCUMENT_TYPE_LABELS[type]} sind für dich nicht freigegeben.`} />;
  }

  const activeFilters = activeFilterCount(filters);
  const typeDate = (document: typeof list.items[number]) => typeDateField(document, type);
  const emptyQuery = activeFilters === 0;
  const nextLink = list.nextCursor
    ? `${buildFilterQuery({ ...filters, cursor: list.nextCursor })}`
    : null;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
            {DOCUMENT_TYPE_SINGULAR_LABELS[type]}
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">{DOCUMENT_TYPE_LABELS[type]}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            {list.totalCount} {list.totalCount === 1 ? "Eintrag" : "Einträge"}
            {activeFilters > 0 ? ` · ${activeFilters} ${activeFilters === 1 ? "Filter" : "Filter"} aktiv` : ""}
          </p>
        </div>
        {list.permissions.canWrite ? (
          <CreateDocumentDialog workspaceId={workspaceId} type={type} groups={groups} />
        ) : (
          <span className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
            Nur Lesezugriff
          </span>
        )}
      </div>

      <form
        key={JSON.stringify(filters)}
        method="GET"
        action={`/w/${workspaceId}/rechnungen/${type}`}
        className="mb-6 grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4"
      >
        <div>
          <label htmlFor={`status-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Status
          </label>
          <select id={`status-${type}`} name="status" defaultValue={filters.status ?? ""} className={inputClass}>
            <option value="">Alle</option>
            <option value="draft">Entwurf</option>
            <option value="issued">Ausgestellt</option>
            <option value="voided">Storniert</option>
          </select>
        </div>

        {moneyTypes.includes(type) ? (
          <div>
            <label htmlFor={`zahlung-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Zahlungsstatus
            </label>
            <select id={`zahlung-${type}`} name="zahlung" defaultValue={filters.zahlung ?? ""} className={inputClass}>
              <option value="">Alle</option>
              {(["unpaid", "partially_paid", "paid", "overdue", "uncollectable"] as const).map((status) => (
                <option key={status} value={status}>{PAYMENT_STATUS_LABELS[status]}</option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={`von-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Ausgestellt von
            </label>
            <input id={`von-${type}`} type="date" name="von" defaultValue={filters.von ?? ""} className={inputClass} />
          </div>
          <div>
            <label htmlFor={`bis-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Ausgestellt bis
            </label>
            <input id={`bis-${type}`} type="date" name="bis" defaultValue={filters.bis ?? ""} className={inputClass} />
          </div>
        </div>

        {type === "invoice" ? (
          <div>
            <label htmlFor={`fdatum-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Fällig bis
            </label>
            <input id={`fdatum-${type}`} type="date" name="fdatumBis" defaultValue={filters.fdatumBis ?? ""} className={inputClass} />
          </div>
        ) : null}

        {type === "credit_note" ? (
          <>
            <div>
              <label htmlFor={`liefer-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Lieferdatum von
              </label>
              <input id={`liefer-${type}`} type="date" name="fdatumVon" defaultValue={filters.fdatumVon ?? ""} className={inputClass} />
            </div>
            <div>
              <label htmlFor={`grund-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Grund
              </label>
              <select id={`grund-${type}`} name="grund" defaultValue={filters.grund ?? ""} className={inputClass}>
                <option value="">Alle</option>
                {(["minderleistung", "empfehlungspraemie"] as const).map((value) => (
                  <option key={value} value={value}>{CREDIT_NOTE_TYPE_LABELS[value]}</option>
                ))}
              </select>
            </div>
          </>
        ) : null}

        <div>
          <label htmlFor={`archiv-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Archiv
          </label>
          <select id={`archiv-${type}`} name="archiv" defaultValue={filters.archiv ?? "active"} className={inputClass}>
            <option value="active">Nur aktive</option>
            <option value="archived">Nur archivierte</option>
            <option value="all">Alle</option>
          </select>
        </div>

        <div>
          <label htmlFor={`suche-${type}`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Suche
          </label>
          <input
            id={`suche-${type}`}
            type="search"
            name="suche"
            defaultValue={filters.suche ?? ""}
            placeholder="Namen durchsuchen"
            className={inputClass}
          />
        </div>

        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Filtern
          </button>
          {!emptyQuery ? (
            <Link
              href={`/w/${workspaceId}/rechnungen/${type}`}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Zurücksetzen
            </Link>
          ) : null}
        </div>
      </form>

      <section aria-label={`${DOCUMENT_TYPE_LABELS[type]} Liste`} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        {list.items.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-600">
            Keine Einträge
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">
                {list.totalCount} {list.totalCount === 1 ? "Eintrag" : "Einträge"}
                {activeFilters > 0 ? ", Filter aktiv" : ""}
              </caption>
              <thead>
                <tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-3 py-3">Name</th>
                  {type !== "letter" ? <th scope="col" className="px-3 py-3 text-right">Betrag</th> : null}
                  <th scope="col" className="px-3 py-3">Status</th>
                  {moneyTypes.includes(type) ? <th scope="col" className="px-3 py-3">Zahlung</th> : null}
                  <th scope="col" className="px-3 py-3">Ausgestellt</th>
                  <th scope="col" className="px-3 py-3">{typeDate(list.items[0]).label}</th>
                  <th scope="col" className="px-3 py-3 text-right">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((document) => {
                  const field = typeDate(document);
                  return (
                    <tr key={document.id} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-3 py-3 text-sm font-medium text-slate-900">
                        {document.name}
                        {document.number !== null ? (
                          <span className="mt-0.5 block text-xs font-normal text-slate-500">{document.number}</span>
                        ) : null}
                        {document.archivedAt !== null ? (
                          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                            Archiviert
                          </span>
                        ) : null}
                      </td>
                      {type !== "letter" ? (
                        <td className="px-3 py-3 text-right text-sm tabular-nums text-slate-900">
                          {formatEuro(document.grossCents)}
                        </td>
                      ) : null}
                      <td className="px-3 py-3 text-sm text-slate-700">
                        {DOCUMENT_STATUS_LABELS[document.status] ?? document.status}
                      </td>
                      {moneyTypes.includes(type) ? (
                        <td className="px-3 py-3 text-sm text-slate-700">
                          {/* Kimi-P1-1: Zelle immer rendern, sonst rutschen die
                              Folgezellen bei Entwürfen (paymentStatus null). */}
                          {document.paymentStatus !== null
                            ? PAYMENT_STATUS_LABELS[document.paymentStatus] ?? document.paymentStatus
                            : "—"}
                        </td>
                      ) : null}
                      <td className="px-3 py-3 text-sm tabular-nums text-slate-700">
                        {document.issuedAt !== null ? formatBerlinDate(document.issuedAt) : "—"}
                      </td>
                      <td className="px-3 py-3 text-sm tabular-nums text-slate-700">
                        {field.value !== null ? formatDateOnly(field.value) : "—"}
                      </td>
                      <td className="px-3 py-3">
                        <DocumentRowActions
                          workspaceId={workspaceId}
                          document={document}
                          canWrite={list.permissions.canWrite}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {nextLink ? (
          <div className="mt-4 flex justify-center">
            <Link
              href={`/w/${workspaceId}/rechnungen/${type}${nextLink}`}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Weitere laden
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}
