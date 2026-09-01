import {
  GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH,
  GLOBAL_TASK_INBOX_QUERY_VERSION,
  GLOBAL_TASK_INBOX_TIME_ZONE,
  globalTaskInboxQueryV1Schema,
  type GlobalTaskInboxQueryV1,
} from "@/lib/integrations/tasks/inbox-contract";

export type GlobalTaskInboxRouteSearchParams = Record<
  string,
  string | string[] | undefined
>;

const QUERY_KEYS = new Set([
  "filter",
  "state",
  "dueBucket",
  "query",
  "asOf",
  "cursor",
]);

function single(
  value: string | string[] | undefined,
): string | null | undefined {
  return Array.isArray(value) ? null : value;
}

// Das Suchfeld begrenzt die Eingabe auf UTF-16-Codeunits VOR der Normalisierung,
// der Vertrag prüft die Länge DANACH. NFKC ist für Kompatibilitätszeichen
// expandierend ("…" wird zu "...", "™" zu "TM"), eine vom Formular akzeptierte
// Eingabe kann die Grenze also erst nach der Normalisierung reißen. Das eigene
// Formular darf die Seite nicht auf ein 404 schicken; deshalb wird hier
// normalisiert und auf die Vertragslänge gekürzt. Die Kürzung läuft über
// Codepoints, damit kein halbes Surrogatpaar stehen bleibt.
function boundedRouteQuery(raw: string | undefined): string {
  if (raw === undefined) return "";
  // Ein bereits roh zu langer Wert kann nicht aus dem Formular stammen; er
  // bleibt strikt abgelehnt und erreicht unverändert die Vertragsprüfung.
  if (raw.length > GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH) return raw;
  const normalized = raw.normalize("NFKC").trim();
  if (normalized.length <= GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH) return raw;
  let bounded = "";
  for (const codePoint of normalized) {
    if (bounded.length + codePoint.length > GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH) break;
    bounded += codePoint;
  }
  return bounded.normalize("NFKC").trim().slice(0, GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH);
}

export function parseGlobalTaskInboxRouteQuery(
  raw: GlobalTaskInboxRouteSearchParams,
): GlobalTaskInboxQueryV1 | null {
  if (Object.keys(raw).some((key) => !QUERY_KEYS.has(key))) return null;

  const filter = single(raw.filter);
  const state = single(raw.state);
  const dueBucket = single(raw.dueBucket);
  const query = single(raw.query);
  const asOf = single(raw.asOf);
  const cursor = single(raw.cursor);
  if (
    filter === null
    || state === null
    || dueBucket === null
    || query === null
    || asOf === null
    || cursor === null
  ) return null;

  const parsed = globalTaskInboxQueryV1Schema.safeParse({
    schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
    filter: filter ?? "mine",
    state: state ?? "open",
    dueBucket: dueBucket ?? "any",
    query: boundedRouteQuery(query),
    timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
    asOf: asOf ?? null,
    cursor: cursor ?? null,
  });
  return parsed.success ? parsed.data : null;
}

export type GlobalTaskInboxHrefState = Pick<
  GlobalTaskInboxQueryV1,
  "filter" | "state" | "dueBucket" | "query" | "asOf" | "cursor"
>;

export function globalTaskInboxHref(
  workspaceId: string,
  state: GlobalTaskInboxHrefState,
): string {
  if ((state.asOf === null) !== (state.cursor === null)) {
    throw new TypeError("Inbox-Fortsetzung benötigt asOf und Cursor gemeinsam");
  }
  const parameters = new URLSearchParams({
    filter: state.filter,
    state: state.state,
    dueBucket: state.dueBucket,
  });
  if (state.query !== null) parameters.set("query", state.query);
  if (state.asOf !== null && state.cursor !== null) {
    parameters.set("asOf", state.asOf);
    parameters.set("cursor", state.cursor);
  }
  return `/w/${workspaceId}/aufgaben?${parameters.toString()}`;
}
