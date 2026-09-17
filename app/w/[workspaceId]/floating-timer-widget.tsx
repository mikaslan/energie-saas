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
    // CI-Befund (F9-07/F9-08/M3-01): Das fixierte Widget darf Seiten-Content
    // niemals zudecken — Hülle pointer-events-none (Toast-Muster), nur der
    // Stopp-Link bleibt klickbar. Kompakte einzeilige Pille minimiert die
    // Rest-Kollisionsfläche des Links.
    <aside
      data-testid="floating-timer-widget"
      aria-label="Laufende Stoppuhr"
      className="pointer-events-none fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)]"
    >
      <div className="flex max-w-full items-center gap-2 rounded-full border border-slate-200 bg-white py-2 pl-4 pr-2 shadow-lg">
        <span className="min-w-0 truncate text-sm text-slate-700" title={running.projectName}>
          <span className="font-semibold text-slate-900">Stoppuhr</span>
          {" · "}
          <span className="tabular-nums">
            <FloatingTimerTicker startAt={running.startAt} />
          </span>
          {" · "}
          {running.projectName}
          {running.typeName ? <span className="text-slate-500"> · {running.typeName}</span> : null}
        </span>
        <Link
          href={`/w/${workspaceId}/anfragen/${running.projectId}/zeiterfassung`}
          className="pointer-events-auto inline-block shrink-0 rounded-full bg-brand-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Stoppen
        </Link>
      </div>
    </aside>
  );
}
