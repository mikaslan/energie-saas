import { z } from "zod";
import { FloatingTimerWidget } from "./floating-timer-widget";

const workspaceIdSchema = z.uuid();

// F9-13: Workspace-Layout — reiner Wrapper (Seiten bleiben verantwortlich
// für 404/Denials) plus Floating-Timer-Widget bei laufendem Eintrag.
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const parsed = workspaceIdSchema.safeParse((await params).workspaceId);
  return (
    <>
      {children}
      {parsed.success ? <FloatingTimerWidget workspaceId={parsed.data} /> : null}
    </>
  );
}
