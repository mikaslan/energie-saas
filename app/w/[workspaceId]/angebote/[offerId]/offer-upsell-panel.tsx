"use client";

import { useMemo, useState } from "react";
import { resolveUpsellTotal } from "@/lib/integrations/offers/upsell";
import { formatOfferCents } from "./offer-format";

export interface UpsellOptionLine {
  lineDomainId: string;
  name: string;
  quantityLabel: string;
  salesGrossCents: number;
}

// F2-06 Slice A: optionale BOM-Komponenten als Upsell-Checkboxen mit
// Live-Summe. Reine Projektion über versiegelte Snapshot-Beträge; die
// Auswahl lebt im Client-State und greift in keine Berechnung ein
// (Bindung an den Signaturinhalt folgt in Slice B).
export function OfferUpsellPanel(props: {
  variantId: string;
  basisGrossCents: number;
  options: readonly UpsellOptionLine[];
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const total = useMemo(
    () => resolveUpsellTotal({
      basisGrossCents: props.basisGrossCents,
      lines: props.options.map((option) => ({
        lineDomainId: option.lineDomainId,
        name: option.name,
        salesGrossCents: option.salesGrossCents,
        positionType: "optional",
        isHidden: false,
      })),
      selectedIds: [...selected],
    }),
    [props.basisGrossCents, props.options, selected],
  );

  function toggle(lineDomainId: string, checked: boolean): void {
    setSelected((current) => checked
      ? (current.includes(lineDomainId) ? current : [...current, lineDomainId])
      : current.filter((candidate) => candidate !== lineDomainId));
  }

  if (props.options.length === 0) return null;

  return (
    <section
      aria-label="Optionale Upsell-Komponenten"
      data-testid="offer-upsell-panel"
      className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
        Optionale Komponenten
      </p>
      <h2 className="mt-1 text-lg font-semibold text-slate-950">
        Upsell für die Signatur
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Basis {formatOfferCents(props.basisGrossCents)} brutto · Auswahl rein
        informativ, wird noch nicht in die Signatur übernommen.
      </p>
      <ul className="mt-4 grid list-none gap-2">
        {props.options.map((option) => {
          const checked = selected.includes(option.lineDomainId);
          return (
            <li key={option.lineDomainId}>
              <label
                data-testid={`offer-upsell-option-${option.lineDomainId}`}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => toggle(option.lineDomainId, event.target.checked)}
                  aria-label={`${option.name} als Upsell wählen`}
                  className="h-4 w-4 accent-emerald-700"
                />
                <span className="flex-1 text-sm text-slate-900">
                  {option.name}
                  <span className="ml-2 text-xs text-slate-600">{option.quantityLabel}</span>
                </span>
                <span className="text-sm font-semibold tabular-nums text-slate-900">
                  {formatOfferCents(option.salesGrossCents)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p
        data-testid="offer-upsell-total"
        aria-live="polite"
        className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-900"
      >
        Summe mit Auswahl:{" "}
        <strong className="tabular-nums">{formatOfferCents(total.totalGrossCents)}</strong>
        {total.selectedIds.length === 0 ? (
          <span className="ml-2 text-xs text-slate-600">(keine Auswahl — Basis)</span>
        ) : null}
      </p>
    </section>
  );
}
