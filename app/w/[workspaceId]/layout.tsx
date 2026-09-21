import { z } from "zod";
import { isWorkspaceIdForTabs } from "@/lib/mobile/tabs";
import { MobileTabBar } from "./_mobile-tab-bar";
import { FloatingTimerWidget } from "./floating-timer-widget";

const workspaceIdSchema = z.uuid();

// F9-13: Workspace-Layout — reiner Wrapper (Seiten bleiben verantwortlich
// für 404/Denials) plus Floating-Timer-Widget bei laufendem Eintrag.
// F11-05: Mobile Tab-Leiste bei UUID-förmiger ID (Fehlerseiten ohne
// Navigation mit toten Zielen); pb-16 hält Inhalt über der fixen Leiste.
// Wave-02-Merge hatte die Leisten-Verdrahtung verloren (add/add take-2b) —
// hier komposiert: Widget + Leiste, kein Entweder-oder.
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const parsed = workspaceIdSchema.safeParse(workspaceId);
  return (
    <>
      <div className="pb-16 md:pb-0">{children}</div>
      {parsed.success ? <FloatingTimerWidget workspaceId={parsed.data} /> : null}
      {isWorkspaceIdForTabs(workspaceId) ? <MobileTabBar workspaceId={workspaceId} /> : null}
    </>
  );
}
