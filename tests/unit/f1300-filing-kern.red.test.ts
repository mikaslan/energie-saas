import { describe, expect, it } from "vitest";

import * as fileRequestLib from "@/lib/file-request";
import * as subsidyChatContract from "@/lib/integrations/subsidies/chat-contract";
import * as subsidyCaseLib from "@/lib/subsidy-case";

// F13-00 Filing-Kern (SPECIFIED, nicht implementiert — siehe
// docs/spec/F13-00-filing-kern.md, §ROT-Beleg). Nur existierende
// Imports (vitest + reine lib-Verträge, Muster
// f1305-portal-activation.test.ts); jede Zusicherung adressiert
// einen noch fehlenden Kern-Export.
// Skip-Grund: reine Spezifikation, kein Kern-Code in diesem Slice —
// ROT belegt (6/6, s. Spec), Entskip je Migrations-Slice (§7).
describe.skip("F13-00 Filing-Kern (RED)", () => {
  it("F1300-U-01: Draft-Status existiert in der Förderakte", () => {
    expect(subsidyCaseLib.subsidyCaseStatuses as readonly string[]).toContain(
      "draft",
    );
  });

  it("F1300-U-02: Submit-Freeze-Gate ist exportiert", () => {
    expect(
      typeof (subsidyCaseLib as Record<string, unknown>)[
        "canEditFilingDetails"
      ],
    ).toBe("function");
  });

  it("F1300-U-03: Slot-Typ-Enum hängt an der Datei-Anfrage", () => {
    expect(
      (fileRequestLib as Record<string, unknown>)["fileRequestSlotTypes"],
    ).toBeDefined();
  });

  it("F1300-U-04: generischer Filing-Chat-Pfad existiert", () => {
    expect(
      (subsidyChatContract as Record<string, unknown>)["filingChatBodySchema"],
    ).toBeDefined();
  });

  it("F1300-U-05: Kanten-Norm-Export (isAllowed-Guard je Maschine)", () => {
    expect(
      typeof (fileRequestLib as Record<string, unknown>)[
        "isAllowedFileRequestTransition"
      ],
    ).toBe("function");
  });

  it("F1300-U-06: Übergangs-Event folgt dem .transition-Naming", () => {
    expect(
      (subsidyCaseLib as Record<string, unknown>)[
        "SUBSIDY_CASE_TRANSITION_EVENT"
      ],
    ).toBe("subsidy_case.transition");
  });
});
