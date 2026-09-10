"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type TouScheduleRow = {
  hour: number;
  chargeKw: number;
  dischargeKw: number;
  gridChargeKw: number;
  socKwh: number;
};

/**
 * F4.4b Ladefahrplan: mittlerer 24-h-Speicherfahrplan (Laden/Entladen kW
 * je Ortsstunde). Reine Darstellung der versionierten TOU-Ergebnisse.
 */
export function TouScheduleChart({ schedule }: { schedule: TouScheduleRow[] }) {
  return (
    <div
      className="mt-3 max-w-full overflow-x-auto"
      data-energy-tou-schedule-chart="true"
      role="region"
      aria-label="Mittlerer 24-Stunden-Ladefahrplan des Speichers, horizontal scrollbar"
    >
      <div className="h-64 min-w-[36rem]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={schedule} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="hour"
              tickFormatter={(hour: number) => `${hour}h`}
              interval={2}
              label={{ value: "Ortsstunde", position: "insideBottomRight", offset: -2 }}
            />
            <YAxis
              label={{ value: "kW", angle: -90, position: "insideLeft" }}
              width={48}
            />
            <Tooltip
              formatter={(value, name) => [
                `${Number(value).toLocaleString("de-DE", { maximumFractionDigits: 3 })} kW`,
                name,
              ]}
              labelFormatter={(hour) => `Stunde ${hour} Uhr`}
            />
            <Legend />
            <Bar dataKey="chargeKw" name="Laden (Ø kW)" fill="#2563eb" />
            <Bar dataKey="dischargeKw" name="Entladen (Ø kW)" fill="#ea580c" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
