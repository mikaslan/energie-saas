import { describe, expect, it } from "vitest";
import { contactNameSplitV1 } from "@/lib/db/schema/contact-name-split";

describe("M1-14 contact_name_split_v1 (deterministisch)", () => {
  it("trimmt U+0020-Leerzeichen und kollabiert interne Whitespace-Läufe", () => {
    expect(contactNameSplitV1("  Erika   Maxi\nMustermann  ")).toEqual({
      firstName: "Erika",
      lastName: "Maxi Mustermann",
    });
  });

  it("kollabiert interne Tabs/CR/LF auf ein Leerzeichen", () => {
    expect(contactNameSplitV1("Erika\tMaxi\r\nMustermann")).toEqual({
      firstName: "Erika",
      lastName: "Maxi Mustermann",
    });
  });

  it("teilt am ersten Whitespace-Lauf", () => {
    expect(contactNameSplitV1("Erika Maxi Mustermann")).toEqual({
      firstName: "Erika",
      lastName: "Maxi Mustermann",
    });
  });

  it("Eintoken → first = last = token", () => {
    expect(contactNameSplitV1("Mustermann")).toEqual({
      firstName: "Mustermann",
      lastName: "Mustermann",
    });
    expect(contactNameSplitV1("  Solo  ")).toEqual({
      firstName: "Solo",
      lastName: "Solo",
    });
  });

  it("leerer/Whitespace-Input → leerer Token (Caller prüft Länge)", () => {
    expect(contactNameSplitV1("   ")).toEqual({ firstName: "", lastName: "" });
  });

  it("mehrere Tokens bleiben im Nachnamen erhalten", () => {
    expect(contactNameSplitV1("Anna Maria von Beispiel")).toEqual({
      firstName: "Anna",
      lastName: "Maria von Beispiel",
    });
  });

  it("P2-3: btrim-Pin — führender Tab wird NICHT getrimmt (leeres first-Token, fail-loud)", () => {
    // Entspricht PostgreSQL btrim(text): nur U+0020 wird getrimmt. Ein
    // führender Tab kollabiert zu einem führenden Leerzeichen und erzeugt
    // deshalb ein leeres first-Token — deckungsgleich mit der SQL-Variante.
    // Der DB-CHECK length(btrim(first_name)) between 1 and 200 weist den Wert
    // dann laut zurück.
    expect(contactNameSplitV1("\tErika Mustermann")).toEqual({
      firstName: "",
      lastName: "Erika Mustermann",
    });
  });
});
