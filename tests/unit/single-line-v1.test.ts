import { describe, expect, it } from "vitest";

import {
  buildSingleLineSchematic,
  type SchematicSectionInput,
} from "@/lib/integrations/schematic/single-line-v1";

function section(
  category: SchematicSectionInput["category"],
  title: string,
): SchematicSectionInput {
  return { category, title, quantityLabel: "1 Stück" };
}

describe("F6-01 Einlinien-Schaltplan", () => {
  it("verdrahtet PV→WR→Zähler→Netz mit DC/AC-Labels", () => {
    const schematic = buildSingleLineSchematic([
      section("module", "PV-Module"),
      section("inverter", "Wechselrichter"),
    ]);
    expect(schematic.empty).toBe(false);
    expect(schematic.nodes.map((node) => node.id)).toEqual([
      "pv",
      "inverter",
      "meter",
      "grid",
    ]);
    expect(schematic.edges).toEqual([
      { from: "pv", to: "inverter", label: "DC" },
      { from: "inverter", to: "meter", label: "AC" },
      { from: "meter", to: "grid", label: "AC" },
    ]);
    expect(schematic.unwired).toEqual([]);
  });

  it("hängt Speicher, Wallbox, Wärmepumpe und Montage an", () => {
    const schematic = buildSingleLineSchematic([
      section("module", "PV-Module"),
      section("inverter", "Wechselrichter"),
      section("battery", "Speicher"),
      section("wallbox", "Wallbox"),
      section("heat_pump", "Wärmepumpe"),
      section("mounting", "Montagesystem"),
      section("other", "Sonstiges"),
    ]);
    const ids = schematic.nodes.map((node) => node.id);
    expect(ids).toContain("battery");
    expect(ids).toContain("wallbox");
    expect(ids).toContain("heatPump");
    expect(ids).toContain("mounting");
    expect(schematic.edges).toContainEqual({
      from: "inverter",
      to: "battery",
      label: "Ladung/Entladung",
    });
    expect(schematic.edges).toContainEqual({
      from: "pv",
      to: "mounting",
      label: "Montage",
    });
    // other wird nie verdrahtet.
    expect(schematic.unwired).toEqual(["Sonstiges"]);
  });

  it("meldet Speicher ohne Wechselrichter als unverdrahtet", () => {
    const schematic = buildSingleLineSchematic([
      section("module", "PV-Module"),
      section("battery", "Speicher"),
    ]);
    expect(schematic.nodes.map((node) => node.id)).not.toContain("battery");
    expect(schematic.unwired).toEqual(["Speicher"]);
    expect(schematic.edges).toContainEqual({ from: "pv", to: "meter", label: "DC" });
  });

  it("ist leer ohne Angebotsinhalt", () => {
    expect(buildSingleLineSchematic([]).empty).toBe(true);
    expect(buildSingleLineSchematic([]).nodes).toEqual([]);
  });
});
