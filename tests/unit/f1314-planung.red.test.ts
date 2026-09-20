import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getTableColumns } from "drizzle-orm";
import { offer } from "@/lib/db/schema/offers";
import { planningRequest } from "@/lib/db/schema/planning-request";
import * as planningRequests from "@/modules/planning-requests";

// F13-14 Planungsservice-Revision (RED-Test, Ref
// docs/spec/F13-14-planungsservice-revision.md):
// NUR existierende Imports — kein Import aus noch nicht geschriebenem Code.
// ROT-Beleg per `npx vitest run tests/unit/f1314-planung.red.test.ts`
// (5 rote Tests, Auszug in der Spec); danach describe.skip bis zur Umsetzung.
// Status-quo-Pins (Draft-Toleranz, kein Reopen) laufen GRUEN und bleiben aktiv
// (F13-11-Bestand, keine Skips auf Pins).

const root = path.resolve(import.meta.dirname, "../..");

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(root, relativePath), "utf8");
}

describe("f1314 Status-quo-Pins (GRUEN, F13-11-Bestand)", () => {
  it("Draft-Toleranz: Anfrage an Draft-Angebot ist zulaessig (kein Angebotsstatus-Gate)", () => {
    const service = readSource("modules/planning-requests/service.ts");
    // Scope-Query bindet das Angebot an Projekt + Workspace ...
    expect(service).toContain("from offer");
    // ... filtert aber NICHT auf den Angebotsstatus (offer kennt heute nur
    // draft, offers.ts:75) — zulaessig bis Q-F13-ANGEBOTSBINDUNG-M2.
    expect(service).not.toMatch(/offer[_.]status|status\s*=\s*'draft'/);
    expect(getTableColumns(offer)).toHaveProperty("status");
  });

  it("kein Reopen: Kette endet terminal in accepted, UNIQUE bleibt offer_id", () => {
    const service = readSource("modules/planning-requests/service.ts");
    expect(service).toContain("accepted: null");
    expect(service).not.toMatch(/accepted"\s*:\s*"(requested|in_progress|finished)"/);
    const schema = readSource("lib/db/schema/planning-request.ts");
    expect(schema).toContain("planning_request_ws_offer_uq");
  });
});

// F13-14 GREEN-Slice (Migration 0263): entskippt 2026-09-20, muss GRÜN werden.
// Spec: docs/spec/F13-14-planungsservice-revision.md.
describe("f1314 Revision (GREEN-Slice 0263)", () => {
  // DAUER-SKIP (Owner-DECIDED, Spec-Widerspruch aufgelöst): S1 verbietet das
  // Preis-Feld bis Q-F13-PREISBELEG-M2 — das FEHLENDE Feld ist das gewollte
  // Verhalten, kein Rot. Test bleibt als Q-Gate bis zur Q-Antwort.
  it.skip("Preis-Feld fehlt (S1: kein Feld bis Q-F13-PREISBELEG-M2)", () => {
    expect(getTableColumns(planningRequest)).toHaveProperty("priceCents");
  });

  it("Revisionsnotiz mit Click-Signatur fehlt (S2: Folgeslice)", () => {
    expect(
      existsSync(path.resolve(root, "modules/planning-request-revisions/service.ts")),
    ).toBe(true);
  });

  it("finished_at fehlt (S4: Frist-Haertung)", () => {
    expect(getTableColumns(planningRequest)).toHaveProperty("finishedAt");
  });

  it("Ueberfaellig-Erkennung fehlt (S4: Badge/Event ohne Automatik)", () => {
    expect("isPlanningRequestOverdue" in planningRequests).toBe(true);
  });

  it("Ueberfaellig-Event fehlt (S4: planning_request.overdue)", () => {
    const service = readSource("modules/planning-requests/service.ts");
    expect(service).toContain("planning_request.overdue");
  });
});
