import Link from "next/link";
import type { ProjectEnergyContext } from "@/modules/energy";
import { Section } from "./_ui";

export function ProductResolutionSection({
  workspaceId,
  projectId,
  pending,
  energyContext,
}: {
  workspaceId: string;
  projectId: string;
  pending: boolean;
  energyContext: ProjectEnergyContext | null;
}) {
  const calculationCurrent = energyContext?.calculation.status === "current";
  const productsPath = `/w/${workspaceId}/anfragen/${projectId}/produkte`;
  return (
    <Section
      title="Produkte und Angebotsvorbereitung"
      intro="Die generische Planung wird hier mit eigenen, revisionsgebundenen Produkten und Preisständen aufgelöst."
    >
      <div className={pending
        ? "rounded-md border border-amber-200 bg-amber-50 px-4 py-3"
        : "rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3"}
      >
        <p className={pending ? "text-sm font-semibold text-amber-950" : "text-sm font-semibold text-emerald-950"}>
          {pending ? "Produkte sind noch offen oder nicht mehr aktuell." : "Produkte sind revisionssicher zugeordnet."}
        </p>
        <p className={pending ? "mt-1 text-sm leading-6 text-amber-900" : "mt-1 text-sm leading-6 text-emerald-900"}>
          Die Zuordnung friert Produktdaten und Netto-Preise ein. Sie ersetzt
          keine technische Kompatibilitätsprüfung und rechnet die Planung nicht neu.
        </p>
      </div>
      {!calculationCurrent ? (
        <p role="note" className="mt-5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          Ohne aktuelle Planungsrechnung kann keine neue Zuordnung bestätigt
          werden. Ein historischer Produktstand und die konkreten Blocker bleiben
          weiterhin einsehbar.
        </p>
      ) : null}
      <Link href={productsPath} className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-md border border-blue-700 bg-white px-4 py-2.5 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 sm:w-auto">
        {calculationCurrent
          ? pending ? "Produkte zuordnen" : "Produktauflösung ansehen"
          : "Produktstand und Blocker ansehen"}
      </Link>
    </Section>
  );
}
