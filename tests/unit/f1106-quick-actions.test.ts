import { describe, expect, it } from "vitest";

import {
  quickActionsForContact,
  quickActionsForDataset,
  quickActionSchema,
  type QuickActionAddress,
  type QuickActionContactWays,
} from "@/lib/mobile/quick-actions";

const NULL_WAYS: QuickActionContactWays = {
  primaryEmail: null,
  secondaryEmail: null,
  phone: null,
  phoneMobile: null,
};

const NULL_ADDRESS: QuickActionAddress = {
  street: null,
  houseNumber: null,
  postalCode: null,
  city: null,
  country: null,
};

const FULL_WAYS: QuickActionContactWays = {
  primaryEmail: "qa-kontakt@example.test",
  secondaryEmail: "qa-zwei@example.test",
  phone: "+4915145678911",
  phoneMobile: "+491702345678",
};

const FULL_ADDRESS: QuickActionAddress = {
  street: "Musterstraße",
  houseNumber: "1",
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
};

describe("F11-06 Quick Actions (Vertrag)", () => {
  it("F1106-U-01: volle Daten liefern alle 5 Aktionen in fester Reihenfolge", () => {
    const actions = quickActionsForContact(FULL_WAYS, FULL_ADDRESS);
    expect(actions.map((action) => action.id)).toEqual([
      "call",
      "sms",
      "whatsapp",
      "email",
      "navigate",
    ]);
    expect(actions.map((action) => action.label)).toEqual([
      "Anrufen",
      "SMS",
      "WhatsApp",
      "E-Mail",
      "Navigation",
    ]);
  });

  it("F1106-U-02: Mobil wird vor Festnetz bevorzugt", () => {
    const actions = quickActionsForContact(FULL_WAYS, NULL_ADDRESS);
    expect(actions.find((action) => action.id === "call")?.href).toBe("tel:+491702345678");
    expect(actions.find((action) => action.id === "sms")?.href).toBe("sms:+491702345678");
    expect(actions.find((action) => action.id === "whatsapp")?.href).toBe(
      "https://wa.me/491702345678",
    );
  });

  it("F1106-U-03: Festnetz als Fallback ohne Mobil", () => {
    const actions = quickActionsForContact({ ...FULL_WAYS, phoneMobile: null }, NULL_ADDRESS);
    expect(actions.find((action) => action.id === "call")?.href).toBe("tel:+4915145678911");
    expect(actions.find((action) => action.id === "sms")?.href).toBe("sms:+4915145678911");
    expect(actions.find((action) => action.id === "whatsapp")?.href).toBe(
      "https://wa.me/4915145678911",
    );
  });

  it("F1106-U-04: ohne Daten keine Aktionen (kein Platzhalter)", () => {
    expect(quickActionsForContact(NULL_WAYS, NULL_ADDRESS)).toEqual([]);
  });

  it("F1106-U-05: E-Mail Primaer vor Sekundaer, ohne beide keine Aktion", () => {
    expect(
      quickActionsForContact(FULL_WAYS, NULL_ADDRESS).find((action) => action.id === "email")?.href,
    ).toBe("mailto:qa-kontakt@example.test");
    const secondaryOnly = quickActionsForContact(
      { ...NULL_WAYS, secondaryEmail: "qa-zwei@example.test" },
      NULL_ADDRESS,
    );
    expect(secondaryOnly.find((action) => action.id === "email")?.href).toBe(
      "mailto:qa-zwei@example.test",
    );
    expect(
      quickActionsForContact(NULL_WAYS, NULL_ADDRESS).some((action) => action.id === "email"),
    ).toBe(false);
  });

  it("F1106-U-06: wa.me traegt Ziffern mit Laenderkennung, ohne Plus", () => {
    const actions = quickActionsForContact(
      { ...NULL_WAYS, phone: "+43123456789" },
      NULL_ADDRESS,
    );
    expect(actions.find((action) => action.id === "whatsapp")?.href).toBe(
      "https://wa.me/43123456789",
    );
  });

  it("F1106-U-07: Navigation ist OSM-Suche mit encodierter Adresse", () => {
    const actions = quickActionsForContact(NULL_WAYS, FULL_ADDRESS);
    expect(actions.find((action) => action.id === "navigate")?.href).toBe(
      "https://www.openstreetmap.org/search?query=Musterstra%C3%9Fe%201%2C%2010115%20Berlin%2C%20DE",
    );
  });

  it("F1106-U-08: Navigation braucht Ort plus Strasse oder PLZ", () => {
    expect(
      quickActionsForContact(NULL_WAYS, { ...NULL_ADDRESS, city: "Berlin" }).some(
        (action) => action.id === "navigate",
      ),
    ).toBe(false);
    const plzOnly = quickActionsForContact(
      NULL_WAYS,
      { ...NULL_ADDRESS, postalCode: "10115", city: "Berlin" },
    );
    expect(plzOnly.find((action) => action.id === "navigate")?.href).toBe(
      "https://www.openstreetmap.org/search?query=10115%20Berlin",
    );
    const streetOnly = quickActionsForContact(
      NULL_WAYS,
      { ...NULL_ADDRESS, street: "Musterstraße", houseNumber: "1", city: "Berlin" },
    );
    expect(streetOnly.find((action) => action.id === "navigate")?.href).toBe(
      "https://www.openstreetmap.org/search?query=Musterstra%C3%9Fe%201%2C%20Berlin",
    );
  });

  it("F1106-U-09: Schema weist leere Labels, fremde IDs und Zusatz-Keys ab", () => {
    const valid = quickActionsForContact(FULL_WAYS, FULL_ADDRESS)[0]!;
    expect(quickActionSchema.safeParse({ ...valid, label: "" }).success).toBe(false);
    expect(quickActionSchema.safeParse({ ...valid, id: "fax" }).success).toBe(false);
    expect(quickActionSchema.safeParse({ ...valid, href: "" }).success).toBe(false);
    expect(quickActionSchema.safeParse({ ...valid, icon: "phone" }).success).toBe(false);
  });

  it("F1106-U-10: nur WhatsApp und Navigation sind extern", () => {
    const actions = quickActionsForContact(FULL_WAYS, FULL_ADDRESS);
    expect(actions.map((action) => action.external)).toEqual([false, false, true, false, true]);
  });

  it("F1106-U-11: jede Aktion erfuellt das zod-Schema", () => {
    for (const action of quickActionsForContact(FULL_WAYS, FULL_ADDRESS)) {
      expect(quickActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it("F1106-U-12: geloeschter Kontakt liefert keine Aktionen", () => {
    expect(
      quickActionsForDataset({
        deletedAt: "2026-09-20T00:00:00.000Z",
        contactWays: FULL_WAYS,
        address: FULL_ADDRESS,
      }),
    ).toEqual([]);
    expect(
      quickActionsForDataset({ deletedAt: null, contactWays: FULL_WAYS, address: FULL_ADDRESS }),
    ).toHaveLength(5);
  });

  it("F1106-U-13: ungeformte Rufnummern entfallen, gueltiger Fallback greift", () => {
    const invalid = quickActionsForContact(
      { ...NULL_WAYS, phoneMobile: "0151 45678911", phone: "030-123" },
      NULL_ADDRESS,
    );
    expect(invalid).toEqual([]);
    const fallback = quickActionsForContact(
      { ...NULL_WAYS, phoneMobile: "0151 45678911", phone: "+4930123456" },
      NULL_ADDRESS,
    );
    expect(fallback.find((action) => action.id === "call")?.href).toBe("tel:+4930123456");
  });

  it("F1106-U-14: Leerstring schattet keinen Fallback", () => {
    const voice = quickActionsForContact(
      { ...NULL_WAYS, phoneMobile: "", phone: "+4930123456" },
      NULL_ADDRESS,
    );
    expect(voice.find((action) => action.id === "call")?.href).toBe("tel:+4930123456");
    const mail = quickActionsForContact(
      { ...NULL_WAYS, primaryEmail: "", secondaryEmail: "qa-zwei@example.test" },
      NULL_ADDRESS,
    );
    expect(mail.find((action) => action.id === "email")?.href).toBe(
      "mailto:qa-zwei@example.test",
    );
  });

  it("F1106-U-15: Sonderzeichen in der Adresse werden encodiert", () => {
    const actions = quickActionsForContact(NULL_WAYS, {
      ...NULL_ADDRESS,
      street: "A&B #1",
      city: "C?D",
    });
    expect(actions.find((action) => action.id === "navigate")?.href).toBe(
      "https://www.openstreetmap.org/search?query=A%26B%20%231%2C%20C%3FD",
    );
  });

  it("F1106-U-16: Ueberlange Adressen werfen nicht, Aktion entfaellt", () => {
    const actions = quickActionsForContact(FULL_WAYS, {
      ...NULL_ADDRESS,
      street: "ß".repeat(200),
      city: "ü".repeat(200),
    });
    expect(actions).toHaveLength(4);
    expect(actions.some((action) => action.id === "navigate")).toBe(false);
  });

  it("F1106-U-17: ungeformte E-Mail entfaellt, geformte Sekundaere greift", () => {
    const fallback = quickActionsForContact(
      { ...NULL_WAYS, primaryEmail: "keine-mail", secondaryEmail: "qa-zwei@example.test" },
      NULL_ADDRESS,
    );
    expect(fallback.find((action) => action.id === "email")?.href).toBe(
      "mailto:qa-zwei@example.test",
    );
    const none = quickActionsForContact(
      { ...NULL_WAYS, primaryEmail: "keine-mail", secondaryEmail: "auch keine" },
      NULL_ADDRESS,
    );
    expect(none.some((action) => action.id === "email")).toBe(false);
  });
});
