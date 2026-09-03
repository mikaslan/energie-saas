import { Section } from "../_ui";

export default function InvoicingLoading() {
  return (
    <div className="grid gap-6">
      <Section title="Daten werden geladen" intro="Einen Moment bitte.">
        <div className="space-y-3" aria-hidden="true">
          <div className="h-10 animate-pulse rounded-md bg-slate-100" />
          <div className="h-10 animate-pulse rounded-md bg-slate-100" />
          <div className="h-10 animate-pulse rounded-md bg-slate-100" />
        </div>
      </Section>
    </div>
  );
}
