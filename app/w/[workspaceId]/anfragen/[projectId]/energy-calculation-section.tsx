import type {
  ProjectEnergyCalculationResult,
  ProjectEnergyContext,
} from "@/modules/energy";
import { DetailItem, Section } from "./_ui";
import { EnergyStatusRefresh } from "./energy-status-refresh";

type ResultValue = ProjectEnergyCalculationResult["value"];
type NewResult = Extract<ResultValue, { branch: "new_installation" }>;
type ExistingResult = Extract<ResultValue, { branch: "existing_installation" }>;
type AnnualEnergy = NewResult["calculation"]["annual"];
type MonthlyEnergy = NewResult["calculation"]["monthly"];

const numberFormatter = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
});
const percentFormatter = new Intl.NumberFormat("de-DE", {
  style: "percent",
  maximumFractionDigits: 1,
});
const monthFormatter = new Intl.DateTimeFormat("de-DE", {
  month: "long",
  timeZone: "UTC",
});

function formatNumber(value: number, unit?: string): string {
  const formatted = numberFormatter.format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatRate(value: number): string {
  return percentFormatter.format(value);
}

function monthLabel(month: number): string {
  return monthFormatter.format(new Date(Date.UTC(2026, month - 1, 1)));
}

function AnnualDetails({ annual }: { annual: AnnualEnergy }) {
  return (
    <dl className="mt-4 grid gap-x-6 sm:grid-cols-2">
      <DetailItem term="Jahreserzeugung" numeric>
        {formatNumber(annual.generationKwh, "kWh")}
      </DetailItem>
      <DetailItem term="Jahresverbrauch" numeric>
        {formatNumber(annual.consumptionKwh, "kWh")}
      </DetailItem>
      <DetailItem term="Eigenverbrauch" numeric>
        {formatNumber(annual.selfConsumptionKwh, "kWh")}
      </DetailItem>
      <DetailItem term="Einspeisung" numeric>
        {formatNumber(annual.feedInKwh, "kWh")}
      </DetailItem>
      <DetailItem term="Netzbezug" numeric>
        {formatNumber(annual.gridImportKwh, "kWh")}
      </DetailItem>
      <DetailItem term="Speicherverluste" numeric>
        {formatNumber(annual.storageLossKwh, "kWh")}
      </DetailItem>
      <DetailItem term="Autarkiegrad" numeric>{formatRate(annual.autonomyRate)}</DetailItem>
      <DetailItem term="Eigenverbrauchsquote" numeric>
        {formatRate(annual.selfConsumptionRate)}
      </DetailItem>
    </dl>
  );
}

function NewMonthlyTable({ monthly }: { monthly: MonthlyEnergy }) {
  return (
    <div
      className="mt-5 max-w-full overflow-x-auto rounded-md border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
      tabIndex={0}
      role="region"
      aria-label="Monatsergebnisse der Planungsrechnung, horizontal scrollbar"
    >
      <table className="min-w-[44rem] w-full border-collapse text-left text-sm tabular-nums">
        <caption className="px-4 py-3 text-left font-semibold text-slate-950">
          Monatsergebnisse der serverseitigen Schätzung
        </caption>
        <thead className="bg-slate-50 text-slate-700">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">Monat</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">Erzeugung</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">Eigenverbrauch</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">Netzbezug</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">Einspeisung</th>
          </tr>
        </thead>
        <tbody>
          {monthly.map((entry) => (
            <tr key={entry.month} className="border-t border-slate-200">
              <th scope="row" className="px-4 py-3 font-medium text-slate-900">
                {monthLabel(entry.month)}
              </th>
              <td className="px-4 py-3 text-right">{formatNumber(entry.generationKwh, "kWh")}</td>
              <td className="px-4 py-3 text-right">{formatNumber(entry.selfConsumptionKwh, "kWh")}</td>
              <td className="px-4 py-3 text-right">{formatNumber(entry.gridImportKwh, "kWh")}</td>
              <td className="px-4 py-3 text-right">{formatNumber(entry.feedInKwh, "kWh")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExistingMonthlyTable({ result }: { result: ExistingResult }) {
  const baseline = result.calculation.baseline.monthly;
  const planned = result.calculation.planned.monthly;
  return (
    <div
      className="mt-5 max-w-full overflow-x-auto rounded-md border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
      tabIndex={0}
      role="region"
      aria-label="Monatsvergleich der Bestandsplanung, horizontal scrollbar"
    >
      <table className="min-w-[48rem] w-full border-collapse text-left text-sm tabular-nums">
        <caption className="px-4 py-3 text-left font-semibold text-slate-950">
          Monatsvergleich: Bestand und Planung
        </caption>
        <thead className="bg-slate-50 text-slate-700">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">Monat</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">Eigenverbrauch Bestand</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">Eigenverbrauch Planung</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">Netzbezug Bestand</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">Netzbezug Planung</th>
          </tr>
        </thead>
        <tbody>
          {planned.map((entry, index) => (
            <tr key={entry.month} className="border-t border-slate-200">
              <th scope="row" className="px-4 py-3 font-medium text-slate-900">
                {monthLabel(entry.month)}
              </th>
              <td className="px-4 py-3 text-right">
                {formatNumber(baseline[index].selfConsumptionKwh, "kWh")}
              </td>
              <td className="px-4 py-3 text-right">
                {formatNumber(entry.selfConsumptionKwh, "kWh")}
              </td>
              <td className="px-4 py-3 text-right">
                {formatNumber(baseline[index].gridImportKwh, "kWh")}
              </td>
              <td className="px-4 py-3 text-right">
                {formatNumber(entry.gridImportKwh, "kWh")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function assumptionSource(value: { resolution: string }): string {
  return value.resolution === "versioned_default"
    ? "Versionierter Planungsstandard"
    : "Geprüfte Rechner-Eingabe";
}

function ResultProvenance({ result }: { result: ProjectEnergyCalculationResult }) {
  const assumptions = result.assumptions;
  return (
    <>
      <details className="mt-5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
          Annahmen und technische Provenienz
        </summary>
        <dl className="mt-2">
          <DetailItem term="Systemverluste" numeric>
            {formatNumber(assumptions.systemLossPercent.value, "%")} · {assumptionSource(assumptions.systemLossPercent)}
          </DetailItem>
          <DetailItem term="Speicherwirkungsgrad" numeric>
            {formatRate(assumptions.storageRoundtripEfficiency.value)} · {assumptionSource(assumptions.storageRoundtripEfficiency)}
          </DetailItem>
          <DetailItem term="Entladetiefe" numeric>
            {formatRate(assumptions.storageDepthOfDischarge.value)} · {assumptionSource(assumptions.storageDepthOfDischarge)}
          </DetailItem>
          <DetailItem term="Moduldegradation pro Jahr" numeric>
            {formatRate(assumptions.moduleDegradationPerYear.value)} · {assumptionSource(assumptions.moduleDegradationPerYear)}
          </DetailItem>
          <DetailItem term="Planungshorizont" numeric>
            {formatNumber(assumptions.horizonYears.value, "Jahre")} · {assumptionSource(assumptions.horizonYears)}
          </DetailItem>
          <DetailItem term="Geplante Inbetriebnahme">
            {assumptions.commissioningDate.value} · {assumptionSource(assumptions.commissioningDate)}
          </DetailItem>
          <DetailItem term="Adress-/Profil-/Bedarfsrevision">
            {result.binding.addressRevision} / {result.binding.profile.revision} / {result.binding.requirement.revision}
          </DetailItem>
          <DetailItem term="Engine">
            {result.sources.modelId} {result.sources.modelVersion}
          </DetailItem>
          <DetailItem term="Providerrezept">
            <code className="break-all font-mono text-xs font-normal">
              {result.sources.providerRecipeVersion}
            </code>
          </DetailItem>
          <DetailItem term="Vertrag / Defaults">
            <code className="break-all font-mono text-xs font-normal">
              {result.sources.contractVersion} / {result.sources.defaultsVersion}
            </code>
          </DetailItem>
          <DetailItem term="Quellrevision">
            <code className="break-all font-mono text-xs font-normal">
              {result.sources.sourceRevision}
            </code>
          </DetailItem>
          <DetailItem term="Ergebnis-Hash">
            <code className="break-all font-mono text-xs font-normal">
              {result.value.resultSha256}
            </code>
          </DetailItem>
        </dl>
      </details>
    </>
  );
}

function PlanningResult({
  result,
  historical = false,
}: {
  result: ProjectEnergyCalculationResult;
  historical?: boolean;
}) {
  const value = result.value;
  return (
    <div className="mt-5">
      <div
        role="note"
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
      >
        <p className="font-semibold">
          {historical ? "Historische serverseitige Schätzung" : "Serverseitig neu berechnete Schätzung"}
        </p>
        <p className="mt-1">
          Nicht F4-referenzvalidiert und nicht angebotsreif. Diese Werte sind
          keine Wirtschaftlichkeits-, Preis- oder Angebotsberechnung.
        </p>
      </div>

      {value.branch === "new_installation" ? (
        <>
          <dl className="mt-4 grid gap-x-6 sm:grid-cols-2">
            <DetailItem term="Geplante PV-Leistung" numeric>
              {formatNumber(value.calculation.systemPeakPowerKwp, "kWp")}
            </DetailItem>
            <DetailItem term="Geplanter Speicher" numeric>
              {formatNumber(value.calculation.plannedStorageCapacityKwh, "kWh")}
            </DetailItem>
          </dl>
          <AnnualDetails annual={value.calculation.annual} />
          <NewMonthlyTable monthly={value.calculation.monthly} />
        </>
      ) : (
        <>
          <dl className="mt-4 grid gap-x-6 sm:grid-cols-2">
            <DetailItem term="Bestehende PV-Leistung" numeric>
              {formatNumber(value.calculation.existingSystemPeakPowerKwp, "kWp")}
            </DetailItem>
            <DetailItem term="Bestehender Speicher" numeric>
              {formatNumber(value.calculation.existingStorageCapacityKwh, "kWh")}
            </DetailItem>
            <DetailItem term="Zusätzlicher Speicher" numeric>
              {formatNumber(value.calculation.addedStorageCapacityKwh, "kWh")}
            </DetailItem>
            <DetailItem term="Zusätzlicher Eigenverbrauch" numeric>
              {formatNumber(value.calculation.delta.additionalSelfConsumptionKwh, "kWh/Jahr")}
            </DetailItem>
            <DetailItem term="Autarkie-Delta" numeric>
              {formatNumber(value.calculation.delta.autonomyRatePercentagePoints, "Prozentpunkte")}
            </DetailItem>
          </dl>
          <h3 className="mt-5 text-sm font-semibold text-slate-950">Baseline</h3>
          <AnnualDetails annual={value.calculation.baseline.annual} />
          <h3 className="mt-5 text-sm font-semibold text-slate-950">Planung</h3>
          <AnnualDetails annual={value.calculation.planned.annual} />
          <ExistingMonthlyTable result={value} />
        </>
      )}

      <ResultProvenance result={result} />
    </div>
  );
}

function blockerMessage(blocker: Extract<
  ProjectEnergyContext["calculation"],
  { status: "blocked" }
>["blocker"]): string {
  if (blocker === "address_pin") {
    return "Eine hausgenaue Adresse und der aktuelle Planungs-Pin müssen bestätigt sein.";
  }
  if (blocker === "energy_profile") return "Speichere zuerst ein aktuelles Energieprofil.";
  if (blocker === "profile_confirmation") {
    return "Bestätige die gespeicherte Profilrevision bewusst.";
  }
  if (blocker === "project_requirement") {
    return "Die aktuellen Projektanforderungen sind unvollständig oder passen nicht zum Profil.";
  }
  return "Für die aktuellen Bindungen wurde noch kein Rechenauftrag angelegt.";
}

function safeFailureMessage(errorCode: string): string {
  if (errorCode === "provider_unavailable" || errorCode === "rate_limited") {
    return "Die Wetterdatenquelle war nicht verfügbar. Es wird kein ungesichertes Ergebnis angezeigt.";
  }
  if (errorCode === "provider_invalid") {
    return "Die gelieferten Wetterdaten waren nicht verlässlich genug für ein Ergebnis.";
  }
  if (errorCode === "engine_unavailable" || errorCode === "worker_unavailable") {
    return "Die Planungsengine war nicht verfügbar. Es wird kein Ersatzwert erfunden.";
  }
  if (errorCode === "engine_invalid") {
    return "Die Berechnung konnte nicht als gültiges Ergebnis bestätigt werden.";
  }
  if (errorCode === "stale") {
    return "Die gebundenen Eingaben wurden während der Berechnung geändert.";
  }
  if (errorCode === "retry_conflict") {
    return "Ein anderer Rechenlauf beanspruchte bereits die aktuellen Eingaben.";
  }
  return "Die Planungsrechnung ist fehlgeschlagen. Interne Details werden nicht im Browser angezeigt.";
}

function runningLabel(status: "queued" | "running" | "retry_wait"): string {
  if (status === "queued") return "Eingereiht";
  if (status === "running") return "Wird serverseitig berechnet";
  return "Wartet auf einen begrenzten technischen Wiederholungsversuch";
}

export function EnergyCalculationSection({
  context,
}: {
  context: ProjectEnergyContext | null;
}) {
  if (context === null) {
    return (
      <Section
        title="Planungsrechnung"
        intro="Revisionsgebundene serverseitige Energieschätzung ohne Economics."
      >
        <div
          data-energy-calculation-state="blocked"
          className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        >
          Die Berechnung ist blockiert, solange kein verlässliches Energie-Readmodel vorliegt.
        </div>
      </Section>
    );
  }

  const calculation = context.calculation;
  return (
    <Section
      title="Planungsrechnung"
      intro="Automatische serverseitige Energieschätzung auf exakt gebundener Adress-, Profil- und Bedarfsrevision."
    >
      <div data-energy-calculation-state={calculation.status}>
        {calculation.status === "blocked" ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
            <p className="font-semibold">Berechnung blockiert</p>
            <p className="mt-1">{blockerMessage(calculation.blocker)}</p>
          </div>
        ) : null}

        {calculation.status === "queued"
        || calculation.status === "running"
        || calculation.status === "retry_wait" ? (
          <div
            aria-busy="true"
            className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-950"
          >
            <p className="font-semibold">{runningLabel(calculation.status)}</p>
            <p className="mt-1">
              Technischer Versuch {calculation.attemptCount}. Ein Resultat wird
              erst nach vollständiger Servervalidierung angezeigt.
            </p>
            <EnergyStatusRefresh statusLabel={runningLabel(calculation.status)} />
          </div>
        ) : null}

        {calculation.status === "failed" ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-950"
          >
            <p className="font-semibold">Planungsrechnung fehlgeschlagen</p>
            <p className="mt-1">{safeFailureMessage(calculation.errorCode)}</p>
            <p className="mt-1">
              Es gibt aktuell keine öffentliche Retry-Aktion. Deshalb wird kein
              wirkungsloser Wiederholungsbutton angeboten.
            </p>
          </div>
        ) : null}

        {calculation.status === "current" ? (
          <>
            <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-950">
              Ergebnis aktuell
            </p>
            <PlanningResult result={calculation.result} />
          </>
        ) : null}

        {calculation.status === "stale" ? (
          <>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
              <p className="font-semibold">Ergebnis veraltet</p>
              <p className="mt-1">
                Adresse, Profil oder Bedarf haben sich geändert. Das alte
                Ergebnis ist klar historisch und darf nicht als aktuell gelten.
              </p>
            </div>
            {calculation.result ? (
              <PlanningResult result={calculation.result} historical />
            ) : null}
          </>
        ) : null}
      </div>
    </Section>
  );
}
