"use client";

import type { SingleLineSchematic } from "@/lib/integrations/schematic/single-line-v1";

const NODE_WIDTH = 120;
const NODE_HEIGHT = 52;

/**
 * F6-01 · Einlinien-Schaltbild als SVG (ESTIMATE-Layout, lesend).
 * Unverdrahtete Sektionen erscheinen als Hinweisliste darunter.
 */
export function SingleLineDiagram({ schematic }: { schematic: SingleLineSchematic }) {
  if (schematic.empty) return null;
  const nodeById = new Map(schematic.nodes.map((node) => [node.id, node]));
  return (
    <div>
      <svg
        viewBox="0 0 640 300"
        role="img"
        aria-label="Einphasiges Übersichtsschaltbild (Entwurf)"
        className="h-auto w-full"
      >
        {schematic.edges.map((edge) => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          if (!from || !to) return null;
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          return (
            <g key={`${edge.from}-${edge.to}`}>
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="#475569"
                strokeWidth={2}
              />
              <text
                x={midX}
                y={midY - 6}
                textAnchor="middle"
                fontSize={11}
                fill="#475569"
              >
                {edge.label}
              </text>
            </g>
          );
        })}
        {schematic.nodes.map((node) => (
          <g key={node.id}>
            <rect
              x={node.x - NODE_WIDTH / 2}
              y={node.y - NODE_HEIGHT / 2}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={8}
              fill="#ffffff"
              stroke="#1d4ed8"
              strokeWidth={node.id === "grid" ? 1.5 : 2}
            />
            <text
              x={node.x}
              y={node.sub === null ? node.y + 4 : node.y - 4}
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              fill="#0f172a"
            >
              {node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label}
            </text>
            {node.sub === null ? null : (
              <text
                x={node.x}
                y={node.y + 13}
                textAnchor="middle"
                fontSize={11}
                fill="#475569"
              >
                {node.sub.length > 20 ? `${node.sub.slice(0, 19)}…` : node.sub}
              </text>
            )}
          </g>
        ))}
      </svg>
      {schematic.unwired.length > 0 ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {`Ohne Leitungsführung (ESTIMATE): ${schematic.unwired.join(", ")}.`}
        </p>
      ) : null}
    </div>
  );
}
