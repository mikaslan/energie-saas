import type {
  ProjectEnergyCalculationResult,
  ProjectEnergyCalculationResultV2,
  ProjectEnergyContext,
} from "@/modules/energy";
import { DetailItem, Section } from "./_ui";
import { EnergyStatusRefresh } from "./energy-status-refresh";
import { TouScheduleChart } from "./tou-schedule-chart";

type ResultValue = ProjectEnergyCalculationResult["value"];
type NewResult = Extract<ResultValue, { branch: "new_installation" }>;
type ExistingResult = Extract<ResultValue, { branch: "existing_installation" }>;
type AnnualEnergy = NewResult["calculation"]["annual"];
type MonthlyEnergy = NewResult["calculation"]["monthly"];
type AnnualEnergyV2 = ProjectEnergyCalculationResultV2["value"]["annual"];
type MonthlyEnergyV2 = ProjectEnergyCalculationResultV2["value"]["monthly"];
type WarningsV2 = ProjectEnergyCalculationResultV2["value"]["warnings"];

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

function warningText(code: WarningsV2[number]["code"]): string {
  if (code === "provider_estimate") {
    return "Geschätzte Eingabedaten: Diese Berechnung nutzt versionierte "
      + "Planungsannahmen (Technik-, Last- und Leistungsannahmen), keine "
      + "vollständig gemessenen Live-Daten. Details in der Provenienz.";
  }
  if (code === "unknown_profile_field") {
    return "Unbekannte Profilfelder wurden bewusst ignoriert.";
  }
  if (code === "existing_installation_limited") {
    return "Bestehende Anlage nur eingeschränkt modelliert.";
  }
  if (code === "bidirectional_charging_not_modeled") {
    return "Bidirektionales Laden ist nicht modelliert.";
  }
  return "Ersatzstrom ist nicht modelliert.";
}

function V2Warnings({ warnings }: { warnings: WarningsV2 }) {
  if (warnings.length === 0) return null;
  return (
    <div
      data-energy-calculation-v2-warnings={warnings.map((warning) => warning.code).join(",")}
      className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
    >
      <p className="font-semibold">Planungshinweise</p>
      <ul className="mt-1 list-disc pl-5">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`}>{warningText(warning.code)}</li>
        ))}
      </ul>
    </div>
  );
}

function V2AnnualDetails({ annual }: { annual: AnnualEnergyV2 }) {
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

function V2MonthlyTable({ monthly }: { monthly: MonthlyEnergyV2 }) {
  return (
    <div
      className="mt-5 max-w-full overflow-x-auto rounded-md border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
      tabIndex={0}
      role="region"
      aria-label="Monatsergebnisse der Viertelstunden-Planungsrechnung, horizontal scrollbar"
    >
      <table className="min-w-[44rem] w-full border-collapse text-left text-sm tabular-nums">
        <caption className="px-4 py-3 text-left font-semibold text-slate-950">
          Monatsergebnisse der Viertelstunden-Planungsrechnung
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

type ExistingInstallationV2 = NonNullable<
  ProjectEnergyCalculationResultV2["value"]["existingInstallation"]
>;

function V2ExistingComparison({ existing }: { existing: ExistingInstallationV2 }) {
  const baselineMonthly = existing.baseline.monthly;
  return (
    <div className="mt-5" data-energy-calculation-v2-existing="true">
      <dl className="grid gap-x-6 sm:grid-cols-2">
        <DetailItem term="Bestandsleistung" numeric>
          {formatNumber(existing.existingSystemPeakPowerKwp, "kWp")}
        </DetailItem>
        <DetailItem term="Bestandsspeicher" numeric>
          {formatNumber(existing.existingStorageCapacityKwh, "kWh")}
        </DetailItem>
        <DetailItem term="Zusaetzlicher Speicher (Planung)" numeric>
          {formatNumber(existing.addedStorageCapacityKwh, "kWh")}
        </DetailItem>
        <DetailItem term="Eigenverbrauch Bestand (Jahr)" numeric>
          {formatNumber(existing.baseline.annual.selfConsumptionKwh, "kWh")}
        </DetailItem>
        <DetailItem term="Zusaetzlicher Eigenverbrauch (Planung minus Bestand)" numeric>
          {formatNumber(existing.delta.additionalSelfConsumptionKwh, "kWh")}
        </DetailItem>
        <DetailItem term="Autarkiegewinn (Prozentpunkte)" numeric>
          {formatNumber(existing.delta.autonomyRatePercentagePoints, "pp")}
        </DetailItem>
      </dl>
      <div
        className="mt-5 max-w-full overflow-x-auto rounded-md border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        tabIndex={0}
        role="region"
        aria-label="Monatsvergleich der Bestandsplanung (v2), horizontal scrollbar"
      >
        <table className="min-w-[48rem] w-full border-collapse text-left text-sm tabular-nums">
          <caption className="px-4 py-3 text-left font-semibold text-slate-950">
            Monatsvergleich: Bestand und Planung (v2)
          </caption>
          <thead className="bg-slate-50 text-slate-700">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">Monat</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Eigenverbrauch Bestand</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Netzbezug Bestand</th>
            </tr>
          </thead>
          <tbody>
            {baselineMonthly.map((entry) => (
              <tr key={entry.month} className="border-t border-slate-200">
                <th scope="row" className="px-4 py-3 font-medium text-slate-900">
                  {monthLabel(entry.month)}
                </th>
                <td className="px-4 py-3 text-right">
                  {formatNumber(entry.selfConsumptionKwh, "kWh")}
                </td>
                <td className="px-4 py-3 text-right">
                  {formatNumber(entry.gridImportKwh, "kWh")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function V2Provenance({ result }: { result: ProjectEnergyCalculationResultV2 }) {
  return (
    <details className="mt-5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
        Annahmen und technische Provenienz (v2)
      </summary>
      <dl className="mt-2">
        <DetailItem term="Zeitauflösung" numeric>Viertelstunde (35.040 Slots)</DetailItem>
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
        <DetailItem term="Vertrag / Annahmen">
          <code className="break-all font-mono text-xs font-normal">
            {result.sources.contractVersion} / {result.assumptions.paramsVersion}
          </code>
        </DetailItem>
        <DetailItem term="Quellrevision">
          <code className="break-all font-mono text-xs font-normal">
            {result.sources.sourceRevision}
          </code>
        </DetailItem>
        <DetailItem term="Eingabe-Hash">
          <code className="break-all font-mono text-xs font-normal">
            {result.value.inputSha256}
          </code>
        </DetailItem>
        <DetailItem term="Qualität">
          {result.value.quality} / {result.value.validationStatus}
        </DetailItem>
      </dl>
    </details>
  );
}

type EconomicsV2 = NonNullable<ProjectEnergyCalculationResultV2["value"]["economics"]>;

const euroFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

const centFormatter = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
});

function feedInSourceLabel(source: EconomicsV2["feedInTariffSource"]): string {
  if (source === "override") return "Override (Projekt)";
  if (source === "post_eeg") return "Post-EEG-Marktwert (ESTIMATE)";
  return "EEG-Default (ESTIMATE)";
}

function V2Economics({ economics }: { economics: EconomicsV2 }) {
  // kumuliert[0] enthaelt -Investition: Jahr-1-Basis ist -Investition.
  const yearly = economics.cumulativeCashflowEuro.map((cumulative, index) => {
    const previous = index === 0
      ? -economics.investmentEuro
      : economics.cumulativeCashflowEuro[index - 1]!;
    return { year: index + 1, savings: cumulative - previous, cumulative };
  });
  return (
    <div className="mt-5" data-energy-calculation-v2-economics="true">
      <h3 className="px-1 text-base font-semibold text-slate-950">
        Wirtschaftlichkeit ({economics.horizonYears}-Jahres-Cashflow)
      </h3>
      <dl className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <DetailItem term="Jahresersparnis (Jahr 1)" numeric>
          {euroFormatter.format(economics.annualSavingsEuro)}
        </DetailItem>
        <DetailItem term="Amortisation" numeric>
          {economics.amortizationYears === null
            ? `nicht im Horizont (${economics.horizonYears} Jahre)`
            : economics.amortizationYears === 0
              ? "sofort (keine Investition)"
              : `Jahr ${economics.amortizationYears}`}
        </DetailItem>
        <DetailItem term="Interner Zinsfuß (IRR)" numeric>
          {economics.irr === null ? "—" : percentFormatter.format(economics.irr)}
        </DetailItem>
        <DetailItem term="Investition" numeric>
          {euroFormatter.format(economics.investmentEuro)}
        </DetailItem>
        <DetailItem term="Bezugspreis (Jahr 1)" numeric>
          {`${centFormatter.format(economics.importPriceCtPerKwh)} Ct/kWh (${economics.priceSource === "profile" ? "Profil" : "Workspace-Default"})`}
        </DetailItem>
        <DetailItem term="Einspeisevergütung" numeric>
          {`${centFormatter.format(economics.feedInTariffCtPerKwh)} Ct/kWh (${feedInSourceLabel(economics.feedInTariffSource)})`}
        </DetailItem>
      </dl>
      <h4 className="mt-4 px-1 text-sm font-semibold text-slate-950">
        Stromrechnung (Jahr 1)
      </h4>
      <dl className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <DetailItem term="Ohne PV" numeric>
          {euroFormatter.format(economics.annualBillsEuro.noPvEuro)}
        </DetailItem>
        <DetailItem term="Mit PV (aktueller Tarif)" numeric>
          {euroFormatter.format(economics.annualBillsEuro.currentEuro)}
        </DetailItem>
        <DetailItem term="Mit PV (Neutarif)" numeric>
          {economics.annualBillsEuro.newTariffEuro === null
            ? "—"
            : euroFormatter.format(economics.annualBillsEuro.newTariffEuro)}
        </DetailItem>
      </dl>
      {economics.tou ? <V2Tou tou={economics.tou} /> : null}
      <div
        className="mt-3 max-w-full overflow-x-auto rounded-md border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        tabIndex={0}
        role="region"
        aria-label="Jahres-Cashflow der Wirtschaftlichkeitsrechnung, horizontal scrollbar"
      >
        <table className="min-w-[32rem] w-full border-collapse text-left text-sm tabular-nums">
          <caption className="px-4 py-3 text-left font-semibold text-slate-950">
            Cashflow je Jahr
          </caption>
          <thead className="bg-slate-50 text-slate-700">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">Jahr</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Ersparnis</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Kumuliert</th>
            </tr>
          </thead>
          <tbody>
            {yearly.map((entry) => (
              <tr key={entry.year} className="border-t border-slate-200">
                <th scope="row" className="px-4 py-3 font-medium text-slate-900">
                  {entry.year}
                </th>
                <td className="px-4 py-3 text-right">{euroFormatter.format(entry.savings)}</td>
                <td className="px-4 py-3 text-right">{euroFormatter.format(entry.cumulative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function V2Tou({ tou }: { tou: NonNullable<EconomicsV2["tou"]> }) {
  const savings = tou.savingsVsFlatEuro;
  return (
    <div className="mt-5" data-energy-calculation-v2-tou="true">
      <h4 className="px-1 text-sm font-semibold text-slate-950">
        Zeitvariabler Tarif &amp; Ladefahrplan (Jahr 1)
      </h4>
      <p className="mt-1 px-1 text-sm leading-6 text-slate-600">
        Preisgeführte Speicherfahrweise zum 24-h-Tarif (ESTIMATE: statischer
        Tagestarif, täglich wiederholt). Positive Ersparnis heißt günstiger
        als der Flattarif mit PV.
      </p>
      <dl className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <DetailItem term="Mit PV (Zeittarif)" numeric>
          {euroFormatter.format(tou.billEuro)}
        </DetailItem>
        <DetailItem term="Ersparnis vs. Flattarif" numeric>
          {`${savings >= 0 ? "+" : "−"}${euroFormatter.format(Math.abs(savings))}`}
        </DetailItem>
        <DetailItem term="Arbitrage-Volumen (Netzladung)" numeric>
          {`${tou.gridChargeKwh.toLocaleString("de-DE", { maximumFractionDigits: 3 })} kWh`}
        </DetailItem>
      </dl>
      <TouScheduleChart schedule={tou.schedule24h} />
    </div>
  );
}

function PlanningResultV2({
  result,
  historical = false,
}: {
  result: ProjectEnergyCalculationResultV2;
  historical?: boolean;
}) {
  const economics = result.value.economics;
  return (
    <div className="mt-5" data-energy-calculation-v2-result="true">
      <div
        role="note"
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
      >
        <p className="font-semibold">
          {historical
            ? "Historische Viertelstunden-Planungsrechnung"
            : "Viertelstunden-Planungsrechnung (v2)"}
        </p>
        <p className="mt-1">
          Enthält versionierte Planungsannahmen (siehe Hinweise).
          {economics
            ? " Die Wirtschaftlichkeit ist eine belegte Näherung (EEG-Sätze und Marktwert als ESTIMATE), keine Angebotsberechnung."
            : " Diese Werte sind keine Wirtschaftlichkeits-, Preis- oder Angebotsberechnung."}
        </p>
      </div>
      <V2Warnings warnings={result.value.warnings} />
      <V2AnnualDetails annual={result.value.annual} />
      {result.value.existingInstallation ? (
        <V2ExistingComparison existing={result.value.existingInstallation} />
      ) : null}
      {economics ? <V2Economics economics={economics} /> : null}
      <V2MonthlyTable monthly={result.value.monthly} />
      <V2Provenance result={result} />
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

        {calculation.status === "currentV2" ? (
          <>
            <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-950">
              Ergebnis aktuell (v2)
            </p>
            <PlanningResultV2 result={calculation.resultV2} />
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
            {calculation.resultV2 ? (
              <PlanningResultV2 result={calculation.resultV2} historical />
            ) : null}
          </>
        ) : null}
      </div>
    </Section>
  );
}
