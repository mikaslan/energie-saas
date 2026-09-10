"use client";

import { Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip } from "recharts";

import { annualSankeyLinks } from "@/lib/integrations/calculation/sankey-v2";

export type SankeyAnnual = {
  directConsumptionKwh: number;
  fromStorageKwh: number;
  feedInKwh: number;
  gridImportKwh: number;
  storageLossKwh: number;
};

const NODE_NAMES = [
  "PV-Erzeugung",
  "Netzbezug",
  "Speicher",
  "Verbrauch",
  "Einspeisung",
  "Verlust",
] as const;

const NODE_FILL: Record<string, string> = {
  "PV-Erzeugung": "#eab308",
  Netzbezug: "#64748b",
  Speicher: "#2563eb",
  Verbrauch: "#16a34a",
  Einspeisung: "#0ea5e9",
  Verlust: "#dc2626",
};

function SankeyNode({ x, y, width, height, payload }: {
  x: number;
  y: number;
  width: number;
  height: number;
  payload: { name: string; value: number };
}) {
  return (
    <Layer>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={Math.max(height, 2)}
        fill={NODE_FILL[payload.name] ?? "#94a3b8"}
        fillOpacity={0.9}
      />
      <text
        x={x + width + 6}
        y={y + Math.max(height, 2) / 2}
        fontSize={12}
        fill="#0f172a"
        dominantBaseline="middle"
      >
        {payload.name}
      </text>
    </Layer>
  );
}

/**
 * F4.5b Energiefluss-Sankey: Jahresfluesse (kWh) aus der Annual-Form.
 * Rein darstellend; Fluesse stammen aus dem versionierten v2-Resultat.
 */
export function EnergySankeyChart({ annual }: { annual: SankeyAnnual }) {
  const links = annualSankeyLinks(annual);
  const indexOf = (name: string): number => NODE_NAMES.indexOf(
    name as (typeof NODE_NAMES)[number],
  );
  const data = {
    nodes: NODE_NAMES.map((name) => ({ name })),
    links: links.map((link) => ({
      source: indexOf(link.source),
      target: indexOf(link.target),
      value: link.valueKwh,
    })),
  };
  return (
    <div
      className="mt-3 max-w-full overflow-x-auto"
      data-energy-sankey-chart="true"
      role="region"
      aria-label="Energiefluss des Jahres (Sankey), horizontal scrollbar"
    >
      <div className="h-80 min-w-[40rem]">
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            node={SankeyNode}
            nodePadding={24}
            margin={{ top: 8, right: 160, bottom: 8, left: 8 }}
          >
            <Tooltip
              formatter={(value) => [
                `${Number(value).toLocaleString("de-DE", { maximumFractionDigits: 1 })} kWh`,
                "Fluss",
              ]}
            />
          </Sankey>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
