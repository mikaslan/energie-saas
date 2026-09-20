import { z } from "zod";

// F11-05 Mobile Tab-Leiste: reiner Navigationsvertrag (kein DB-Zugriff,
// kein I/O). Genau die 5 Katalog-Tabs aus F11.1 plus die Linkliste der
// Mehr-Seite; die Komponente in `app/w/[workspaceId]/` rendert nur.

export const mobileTabSchema = z.strictObject({
  id: z.enum(["home", "projects", "tasks", "calendar", "more"]),
  label: z.string().min(1).max(40),
  href: z.string().min(1).max(200),
});
export type MobileTab = z.infer<typeof mobileTabSchema>;
export type MobileTabId = MobileTab["id"];

const TAB_DEFINITIONS: Array<{ id: MobileTabId; label: string; segment: string }> = [
  { id: "home", label: "Home", segment: "dashboard" },
  { id: "projects", label: "Projekte", segment: "anfragen" },
  { id: "tasks", label: "Aufgaben", segment: "aufgaben" },
  { id: "calendar", label: "Kalender", segment: "kalender" },
  { id: "more", label: "Mehr", segment: "mehr" },
];

export function tabsForWorkspace(workspaceId: string): MobileTab[] {
  return TAB_DEFINITIONS.map((definition) =>
    mobileTabSchema.parse({
      id: definition.id,
      label: definition.label,
      href: `/w/${workspaceId}/${definition.segment}`,
    }));
}

export function activeMobileTabId(pathname: string, workspaceId: string): MobileTabId | null {
  const base = `/w/${workspaceId}/`;
  if (!pathname.startsWith(base)) return null;
  const segment = pathname.slice(base.length).split("/", 1)[0] ?? "";
  return TAB_DEFINITIONS.find((definition) => definition.segment === segment)?.id ?? null;
}

const workspaceIdSchema = z.uuid();

export function isWorkspaceIdForTabs(workspaceId: string): boolean {
  return workspaceIdSchema.safeParse(workspaceId).success;
}

export const MOBILE_MORE_LINKS: Array<{ label: string; segment: string }> = [
  { label: "Angebote", segment: "angebote" },
  { label: "Plantafel", segment: "plantafel" },
  { label: "Rechnungen", segment: "rechnungen" },
  { label: "Sites", segment: "sites" },
  { label: "Katalog", segment: "katalog" },
];
// Hinweis: KEIN Einstellungen-Eintrag — `einstellungen/` hat keine
// Root-Seite (nur 19 Unterbereiche), ein Link wäre tot. Eine
// Einstellungs-Übersichtsseite ist eigener Slice-Scope, kein Anhängsel.
