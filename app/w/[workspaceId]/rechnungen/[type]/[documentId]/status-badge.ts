// F8-23d: Status-Badge-Mapping für den Detail-Kopf (reine Funktion,
// separat testbar). Sent ist boolesche Achse (issued + sentAt).
export type StatusBadgeTone = "slate" | "blue" | "emerald" | "zinc";

export function documentStatusBadge(
  status: string,
  sentAt: string | null,
): { label: string; tone: StatusBadgeTone } {
  if (status === "voided") return { label: "Storniert", tone: "zinc" };
  if (status === "draft") return { label: "Entwurf", tone: "slate" };
  if (sentAt !== null) return { label: "Versendet", tone: "emerald" };
  return { label: "Ausgestellt", tone: "blue" };
}

export function statusBadgeClassName(tone: StatusBadgeTone): string {
  const tones: Record<StatusBadgeTone, string> = {
    slate: "bg-slate-100 text-slate-700",
    blue: "bg-blue-100 text-blue-900",
    emerald: "bg-emerald-100 text-emerald-900",
    zinc: "bg-zinc-200 text-zinc-700",
  };
  return `inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${tones[tone]}`;
}
