import { describe, expect, it } from "vitest";

import {
  fileRequestStatuses,
  isAllowedFileRequestTransition,
  nextFileRequestStatuses,
  type FileRequestStatus,
} from "@/lib/file-request";
import * as fileRequestLib from "@/lib/file-request";
import * as subsidyChatContract from "@/lib/integrations/subsidies/chat-contract";
import {
  canEditFilingDetails,
  nextSubsidyCaseStatuses,
  subsidyCaseStatuses,
  type SubsidyCaseStatus,
} from "@/lib/subsidy-case";
import * as subsidyCaseLib from "@/lib/subsidy-case";

// F13-00 Filing-Kern (SPECIFIED, nicht implementiert — siehe
// docs/spec/F13-00-filing-kern.md, §ROT-Beleg). Nur existierende
// Imports (vitest + reine lib-Verträge, Muster
// f1305-portal-activation.test.ts); jede Zusicherung adressiert
// einen noch fehlenden Kern-Export.
// F13-00 GREEN-Slice (Migration 0260): entskippt 2026-09-20, muss GRÜN werden.
// Spec: docs/spec/F13-00-filing-kern.md (§7 Pilot subsidy_case).
describe("F13-00 Filing-Kern (GREEN-Slice 0260)", () => {
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

// F13-00 GREEN-Slice 0260: Guard-Semantik (rein, kein DB-Boot).
describe("F13-00 Filing-Kern (Guard-Semantik)", () => {
  it("F1300-U-07: Submit-Freeze (Edits nur in draft/korrektur)", () => {
    expect(canEditFilingDetails("draft")).toBe(true);
    expect(canEditFilingDetails("korrektur")).toBe(true);
    for (const status of subsidyCaseStatuses) {
      if (status === "draft" || status === "korrektur") continue;
      expect(canEditFilingDetails(status)).toBe(false);
    }
  });

  it("F1300-U-08: Draft-Kanten (→ vorbereitung/storniert, kein Zurück)", () => {
    expect(nextSubsidyCaseStatuses("draft")).toEqual(["vorbereitung", "storniert"]);
    for (const status of subsidyCaseStatuses) {
      if (status === "draft") continue;
      expect(nextSubsidyCaseStatuses(status as SubsidyCaseStatus)).not.toContain("draft");
    }
  });

  it("F1300-U-09: isAllowed-Guard spiegelt die Kantentabelle (file_request)", () => {
    for (const from of fileRequestStatuses) {
      for (const to of fileRequestStatuses) {
        expect(isAllowedFileRequestTransition(from, to)).toBe(
          nextFileRequestStatuses(from as FileRequestStatus).includes(to as FileRequestStatus),
        );
      }
    }
    // Token-Pfad bleibt exklusiv: hochgeladen nie via internen Guard.
    expect(isAllowedFileRequestTransition("offen", "hochgeladen")).toBe(false);
  });
});
