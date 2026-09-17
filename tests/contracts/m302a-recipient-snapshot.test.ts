import { describe, expect, it } from "vitest";

type SnapshotData = {
  displayName: string;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
};

type SnapshotSchema = {
  safeParse: (input: unknown) => {
    success: boolean;
    data?: SnapshotData;
    error?: { issues: Array<{ code: string; path: Array<string | number> }> };
  };
};

async function loadSchema(): Promise<SnapshotSchema> {
  const mod = await import("@/lib/integrations/invoicing/contract") as unknown as Record<string, unknown>;
  expect(typeof (mod.commercialRecipientSnapshotV1Schema as SnapshotSchema | undefined)?.safeParse)
    .toBe("function");
  return mod.commercialRecipientSnapshotV1Schema as SnapshotSchema;
}

const valid = {
  displayName: "Müller GmbH",
  street: "Hauptstraße",
  houseNumber: "12a",
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
};

describe("M302A-CONTRACT-01: Empfänger-Snapshot (Zod)", () => {
  it("nimmt vollständige Adressen an (alle Felder gesetzt)", async () => {
    expect((await loadSchema()).safeParse(valid).success).toBe(true);
  });

  it("nimmt minimale Snapshots an (nur displayName, Rest null)", async () => {
    const schema = await loadSchema();
    expect(schema.safeParse({
      displayName: "Solo AG",
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      country: null,
    }).success).toBe(true);
  });

  it("verlangt displayName (Pflicht, 1..200 nach Trim)", async () => {
    const schema = await loadSchema();
    expect(schema.safeParse({ ...valid, displayName: null }).success).toBe(false);
    expect(schema.safeParse({ ...valid, displayName: "   " }).success).toBe(false);
    expect(schema.safeParse({ ...valid, displayName: "A".repeat(201) }).success).toBe(false);
    const { displayName: _omitted, ...without } = valid;
    expect(_omitted).toBe("Müller GmbH");
    expect(schema.safeParse(without).success).toBe(false);
  });

  it("cappt Adressfelder (Kontakt-CHECK-Spiegel: 200/30/20/200/20)", async () => {
    const schema = await loadSchema();
    expect(schema.safeParse({ ...valid, street: "S".repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ ...valid, street: "S".repeat(200) }).success).toBe(true);
    expect(schema.safeParse({ ...valid, houseNumber: "1".repeat(31) }).success).toBe(false);
    expect(schema.safeParse({ ...valid, houseNumber: "1".repeat(30) }).success).toBe(true);
    expect(schema.safeParse({ ...valid, postalCode: "1".repeat(21) }).success).toBe(false);
    expect(schema.safeParse({ ...valid, postalCode: "1".repeat(20) }).success).toBe(true);
    expect(schema.safeParse({ ...valid, city: "C".repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ ...valid, city: "C".repeat(200) }).success).toBe(true);
    expect(schema.safeParse({ ...valid, country: "D".repeat(21) }).success).toBe(false);
    expect(schema.safeParse({ ...valid, country: "D".repeat(20) }).success).toBe(true);
    expect(schema.safeParse({ ...valid, displayName: "N".repeat(200) }).success).toBe(true);
  });

  it("zählt Codepoints wie PG-length (non-BMP) und trimmt nur Spaces", async () => {
    const schema = await loadSchema();
    // 150 Emoji = 150 PG-Zeichen (legal), aber 300 UTF-16-Units.
    const emoji150 = String.fromCodePoint(0x1f600).repeat(150);
    expect(emoji150.length).toBe(300);
    const emojiParsed = schema.safeParse({ ...valid, displayName: emoji150 });
    expect(emojiParsed.success).toBe(true);
    // Tab: PG-btrim kürzt nur Spaces → legal (1 Zeichen), kein JS-Trim.
    const tabParsed = schema.safeParse({ ...valid, displayName: "\t" });
    expect(tabParsed.success).toBe(true);
    if (!tabParsed.success) return;
    expect(tabParsed.data?.displayName).toBe("\t");
  });

  it("normalisiert NFC + Trim (Transform beweisbar)", async () => {
    const schema = await loadSchema();
    const decomposed = "  Mu\u0308ller GmbH  ";
    const parsed = schema.safeParse({ ...valid, displayName: decomposed });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data?.displayName).toBe("M\u00fcller GmbH");
  });

  it("mappt blanke Optionale auf null (kein Leerstring im Siegel)", async () => {
    const schema = await loadSchema();
    const parsed = schema.safeParse({ ...valid, city: "   ", country: null });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data?.city).toBeNull();
    expect(parsed.data?.displayName).toBe("Müller GmbH");
  });

  it("weist unwohlgeformtes Unicode ab (Lone-Surrogat, NUL, beide Feldarten)", async () => {
    const schema = await loadSchema();
    const lone = 'A' + String.fromCharCode(0xd800) + 'B';
    const nul = 'A' + String.fromCharCode(0) + 'B';
    expect(schema.safeParse({ ...valid, displayName: lone }).success).toBe(false);
    expect(schema.safeParse({ ...valid, city: lone }).success).toBe(false);
    expect(schema.safeParse({ ...valid, displayName: nul }).success).toBe(false);
    expect(schema.safeParse({ ...valid, city: nul }).success).toBe(false);
  });

  it("normalisiert Optionale (Space-Trim + NFC wie Pflichtfelder)", async () => {
    const schema = await loadSchema();
    const parsed = schema.safeParse({ ...valid, street: '  Weg  ', city: '  München  ' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data?.street).toBe('Weg');
    expect(parsed.data?.city).toBe('München');
  });

  it("weist unbekannte Keys ab (strict)", async () => {
    const schema = await loadSchema();
    expect(schema.safeParse({ ...valid, email: "x@y.test" }).success).toBe(false);
  });
});
