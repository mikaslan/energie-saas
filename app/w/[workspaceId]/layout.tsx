import { isWorkspaceIdForTabs } from "@/lib/mobile/tabs";
import { MobileTabBar } from "./_mobile-tab-bar";

// F11-05: erstes w-weites Layout — reiner Wrapper (Muster F9-13 auf Lane
// 2b: kein eigenes notFound, der Bestand je Seite entscheidet weiter
// über ungültige workspaceId). Die Leiste selbst wird nur bei
// UUID-förmiger ID gerendert, damit Fehlerseiten keine Navigation mit
// toten Zielen tragen. HINWEIS FÜR DEN MERGE: Lane 2b legt dieselbe
// Datei für das Floating-Timer-Widget an — beide Elemente komposieren
// (Widget + Leiste), kein Entweder-oder.
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <>
      <div className="pb-16 md:pb-0">{children}</div>
      {isWorkspaceIdForTabs(workspaceId) ? <MobileTabBar workspaceId={workspaceId} /> : null}
    </>
  );
}
