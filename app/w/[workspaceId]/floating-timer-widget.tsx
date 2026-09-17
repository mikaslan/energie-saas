import Link from "next/link";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { getMyRunningTimeEntry } from "@/modules/time-tracking";
import { FloatingTimerTicker } from "./floating-timer-ticker";

// F9-13 Floating-Timer: Server-Widget im Workspace-Layout. Rendert genau
// dann, wenn der Actor einen laufenden Eintrag hat — sonst null (kein
// Layout-Shift). Der Stopp bleibt explizit: Deep-Link zum bestehenden
// Stopp-Formular („nie raten", kein Minuten-Erfinden).
export async function FloatingTimerWidget({ workspaceId }: { workspaceId: string }) {
  let running: Awaited<ReturnType<typeof getMyRunningTimeEntry>>;
  try {
    running = await authorizedQuery(workspaceId, "time.read", "time_tracking", (tx, ctx) =>
      getMyRunningTimeEntry(tx, ctx),
    );
  } catch (error) {
    // Ohne Session/Recht gibt es kein Widget — Seiten regeln Denials selbst.
    if (error instanceof NotAuthenticatedError || error instanceof PermissionDeniedError) return null;
    throw error;
  }
  if (!running) return null;
  return (
    <aside
      data-testid="floating-timer-widget"
      aria-label="Laufende Stoppuhr"
      className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Stoppuhr läuft</p>
      <p className="mt-1 truncate text-sm font-semibold text-slate-900" title={running.projectName}>
        {running.projectName}
      </p>
      <p className="mt-0.5 text-sm tabular-nums text-slate-700">
        <FloatingTimerTicker startAt={running.startAt} />
        {running.typeName ? <span className="text-slate-500"> · {running.typeName}</span> : null}
      </p>
      <Link
        href={`/w/${workspaceId}/anfragen/${running.projectId}/zeiterfassung`}
        className="mt-2 inline-block min-h-11 rounded-md bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        Stoppen
      </Link>
    </aside>
  );
}
