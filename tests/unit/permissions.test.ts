import { describe, it, expect } from "vitest";
import { can, ACTION_REQUIREMENTS, type Action, type PermissionCtx } from "@/lib/permissions";
import type { Role } from "@/lib/db/schema";

const ctx = (role: Role, caps: Record<string, boolean> = {}, flags: Record<string, boolean> = { invoicing: true }) =>
  ({ role, capabilities: caps, featureFlags: flags });

describe("Rechte-Matrix: Action × Rolle × Capability", () => {
  it("viewer darf nie schreiben", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) {
      if (ACTION_REQUIREMENTS[a].minRole !== "viewer") expect(can(ctx("viewer"), a), a).toBe(false);
    }
  });
  it("editor braucht die jeweilige Capability", () => {
    expect(can(ctx("editor"), "invoice.issue")).toBe(false);
    expect(can(ctx("editor", { invoicing: true }), "invoice.issue")).toBe(true);
    expect(can(ctx("editor"), "price.read_purchase")).toBe(false);
    expect(can(ctx("editor", { see_purchase_prices: true }), "price.read_purchase")).toBe(true);
    expect(can(ctx("editor"), "offer.release.prepare")).toBe(false);
    expect(can(ctx("editor", { prepare_offer_documents: true }), "offer.release.prepare")).toBe(true);
    expect(can(ctx("editor"), "offer.release.approve")).toBe(false);
    expect(can(ctx("editor", { approve_offer_documents: true }), "offer.release.approve")).toBe(true);
    expect(can(ctx("editor"), "offer.issue.prepare")).toBe(false);
    expect(can(ctx("editor", { prepare_offer_documents: true }), "offer.issue.prepare")).toBe(true);
    expect(can(ctx("editor"), "offer.issue.approve")).toBe(false);
    expect(can(ctx("editor", { approve_offer_documents: true }), "offer.issue.approve")).toBe(true);
    expect(can(ctx("editor"), "offer.issue.withdraw")).toBe(false);
    expect(can(ctx("editor", { approve_offer_documents: true }), "offer.issue.withdraw")).toBe(true);
  });
  it("admin impliziert alle Capabilities", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) expect(can(ctx("admin"), a), a).toBe(true);
  });
  it("deaktiviertes Workspace-Feature schlägt alles", () => {
    expect(can(ctx("admin", {}, { invoicing: false }), "invoice.issue")).toBe(false);
  });
  it("jede Action hat einen Eintrag (Vollständigkeit)", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) {
      expect(ACTION_REQUIREMENTS[a].minRole).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// UNABHÄNGIGE Erwartungstabelle (Codex-Review #24).
//
// Die Tests oben leiten ihre Erwartung aus ACTION_REQUIREMENTS ab und testen
// damit die Implementierung gegen sich selbst: würde `project.write.minRole`
// versehentlich auf "viewer" gesenkt, wanderte die Action einfach in den
// "if (minRole !== 'viewer') continue"-Zweig und der Fehler bliebe unbemerkt.
//
// Diese Tabelle ist deshalb HANDGESCHRIEBEN und wird NICHT aus
// ACTION_REQUIREMENTS abgeleitet. Sie ist die zweite, unabhängige Quelle der
// Wahrheit: 12 Actions × 3 Rollen, jeweils ohne und mit Capability, plus die
// Feature-Flag-Spalte. Wer ACTION_REQUIREMENTS ändert, MUSS diese Tabelle
// bewusst mitändern — genau das ist der Sinn.
//
// Spalten je Zelle: [ohne Capability, mit der jeweiligen Capability]
// Feature-Flags sind hier ALLE an (invoicing: true); der Feature-Aus-Fall
// steht separat in FEATURE_OFF_EXPECTATIONS.
// ═══════════════════════════════════════════════════════════════════════

type Expectation = { viewer: [boolean, boolean]; editor: [boolean, boolean]; admin: [boolean, boolean] };

const MATRIX: Record<Action, { capability?: string; expect: Expectation }> = {
  // Lesen: jede Rolle darf, keine Capability im Spiel.
  "project.read": {
    expect: { viewer: [true, true], editor: [true, true], admin: [true, true] },
  },
  // Schreiben: ab editor, keine Capability.
  "project.write": {
    expect: { viewer: [false, false], editor: [true, true], admin: [true, true] },
  },
  "project.outcome.write": {
    expect: { viewer: [false, false], editor: [true, true], admin: [true, true] },
  },
  "project.assign": {
    capability: "assign_projects",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "project.activity.read": {
    expect: { viewer: [true, true], editor: [true, true], admin: [true, true] },
  },
  "task.read": {
    expect: { viewer: [true, true], editor: [true, true], admin: [true, true] },
  },
  "task.write": {
    expect: { viewer: [false, false], editor: [true, true], admin: [true, true] },
  },
  "note.read": {
    expect: { viewer: [true, true], editor: [true, true], admin: [true, true] },
  },
  "note.write": {
    expect: { viewer: [false, false], editor: [true, true], admin: [true, true] },
  },
  "contact.read": {
    expect: { viewer: [true, true], editor: [true, true], admin: [true, true] },
  },
  "contact.write": {
    expect: { viewer: [false, false], editor: [true, true], admin: [true, true] },
  },
  "appointment.read": {
    expect: { viewer: [true, true], editor: [true, true], admin: [true, true] },
  },
  "appointment.write": {
    expect: { viewer: [false, false], editor: [true, true], admin: [true, true] },
  },
  // Ab hier: editor braucht die Capability, admin nicht (Admin impliziert alle).
  "phase.convert": {
    capability: "convert_phase",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "price.read_purchase": {
    capability: "see_purchase_prices",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "price.edit": {
    capability: "edit_prices",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "discount.apply": {
    capability: "discounts",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "invoice.issue": {
    capability: "invoicing",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "offer.release.prepare": {
    capability: "prepare_offer_documents",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "offer.release.approve": {
    capability: "approve_offer_documents",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "offer.issue.prepare": {
    capability: "prepare_offer_documents",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "offer.issue.approve": {
    capability: "approve_offer_documents",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "offer.issue.withdraw": {
    capability: "approve_offer_documents",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  "catalog.read": {
    expect: { viewer: [true, true], editor: [true, true], admin: [true, true] },
  },
  "catalog.manage": {
    capability: "manage_catalog",
    expect: { viewer: [false, false], editor: [false, true], admin: [true, true] },
  },
  // Nur admin, keine Capability.
  "settings.manage": {
    expect: { viewer: [false, false], editor: [false, false], admin: [true, true] },
  },
};

// Feature-Flag AUS schlägt alles — auch admin, auch mit Capability.
const FEATURE_OFF_EXPECTATIONS: { action: Action; feature: string }[] = [
  { action: "invoice.issue", feature: "invoicing" },
];

const ROLES: Role[] = ["viewer", "editor", "admin"];

describe("Rechte-Matrix gegen unabhängige Erwartungstabelle", () => {
  it("deckt exakt die 26 definierten Actions ab (keine still hinzugefügte Action)", () => {
    expect(Object.keys(MATRIX).sort()).toEqual(Object.keys(ACTION_REQUIREMENTS).sort());
    expect(Object.keys(MATRIX)).toHaveLength(26);
  });

  it("26 Actions × 3 Rollen × Capability an/aus", () => {
    for (const [action, spec] of Object.entries(MATRIX) as [Action, (typeof MATRIX)[Action]][]) {
      for (const role of ROLES) {
        const [withoutCap, withCap] = spec.expect[role];
        expect(can(ctx(role, {}), action), `${action} / ${role} / ohne Capability`).toBe(withoutCap);
        const caps = spec.capability ? { [spec.capability]: true } : {};
        expect(can(ctx(role, caps), action), `${action} / ${role} / mit Capability`).toBe(withCap);
      }
    }
  });

  it("Feature aus → false für jede Rolle, auch mit Capability", () => {
    for (const { action, feature } of FEATURE_OFF_EXPECTATIONS) {
      for (const role of ROLES) {
        expect(can(ctx(role, { [feature]: true }, { [feature]: false }), action), `${action} / ${role}`).toBe(false);
      }
    }
  });
});

describe("M1-09 Projektzuweisung ist eine getrennte interne Berechtigungsgrenze", () => {
  it("verlangt Editor plus assign_projects oder Admin", () => {
    expect(can(ctx("viewer", { assign_projects: true }), "project.assign")).toBe(false);
    expect(can(ctx("editor"), "project.assign")).toBe(false);
    expect(can(ctx("editor", { assign_projects: false }), "project.assign")).toBe(false);
    expect(can(ctx("editor", { assign_projects: true }), "project.assign")).toBe(true);
    expect(can(ctx("admin"), "project.assign")).toBe(true);
  });

  it("sperrt external_only auch bei Editor/Admin und malformed Flags", () => {
    expect(can(ctx("editor", {
      assign_projects: true,
      external_only: true,
    }), "project.assign")).toBe(false);
    expect(can(ctx("admin", { external_only: true }), "project.assign")).toBe(false);
    expect(can(ctx("editor", {
      assign_projects: true,
      external_only: false,
    }), "project.assign")).toBe(true);

    const malformed = {
      role: "admin",
      capabilities: { external_only: "false", assign_projects: true },
      featureFlags: {},
    } as unknown as PermissionCtx;
    expect(can(malformed, "project.assign")).toBe(false);
  });

  it("verwendet kein Workspace-Feature als Ersatz", () => {
    expect(can(ctx("editor", {}, { assign_projects: true }), "project.assign")).toBe(false);
    expect(ACTION_REQUIREMENTS["project.assign"]).not.toHaveProperty("feature");
    expect(ACTION_REQUIREMENTS["project.assign"]).toMatchObject({
      minRole: "editor",
      capability: "assign_projects",
      internalOnly: true,
    });
  });
});

describe("M1-10 Aufgaben sind eine getrennte interne Berechtigungsgrenze", () => {
  it("lässt interne Viewer nur lesen und Editor/Admin zusätzlich schreiben", () => {
    expect(can(ctx("viewer"), "task.read")).toBe(true);
    expect(can(ctx("viewer"), "project.activity.read")).toBe(true);
    expect(can(ctx("viewer"), "task.write")).toBe(false);
    expect(can(ctx("editor"), "task.read")).toBe(true);
    expect(can(ctx("editor"), "task.write")).toBe(true);
    expect(can(ctx("admin"), "task.read")).toBe(true);
    expect(can(ctx("admin"), "task.write")).toBe(true);
  });

  it("sperrt External und malformed Flags für Lesen und Schreiben fail-closed", () => {
    for (const action of ["task.read", "task.write", "project.activity.read"] as const) {
      expect(can(ctx("admin", { external_only: true }), action), action).toBe(false);
      expect(can(ctx("admin", { external_only: false }), action), action).toBe(true);
      const malformed = {
        role: "admin",
        capabilities: { external_only: "false" },
        featureFlags: {},
      } as unknown as PermissionCtx;
      expect(can(malformed, action), `${action} / malformed`).toBe(false);
      expect(ACTION_REQUIREMENTS[action]).toHaveProperty("internalOnly", true);
    }
  });
});

describe("M1-11a Outcome ist eine getrennte interne Berechtigungsgrenze", () => {
  it("verlangt mindestens einen internen Editor ohne Ersatz-Feature", () => {
    expect(can(ctx("viewer"), "project.outcome.write")).toBe(false);
    expect(can(ctx("editor"), "project.outcome.write")).toBe(true);
    expect(can(ctx("admin"), "project.outcome.write")).toBe(true);
    expect(ACTION_REQUIREMENTS["project.outcome.write"]).toEqual({
      minRole: "editor",
      internalOnly: true,
    });
  });

  it("sperrt External und malformed Flags fail-closed", () => {
    expect(can(ctx("editor", { external_only: true }), "project.outcome.write")).toBe(false);
    expect(can(ctx("admin", { external_only: true }), "project.outcome.write")).toBe(false);
    expect(can(ctx("editor", { external_only: false }), "project.outcome.write")).toBe(true);
    const malformed = {
      role: "admin",
      capabilities: { external_only: "false" },
      featureFlags: {},
    } as unknown as PermissionCtx;
    expect(can(malformed, "project.outcome.write")).toBe(false);
  });
});

describe("M2-03a Angebotsfreigabe bleibt eine interne Berechtigungsgrenze", () => {
  const releaseActions = [
    { action: "offer.release.prepare", capability: "prepare_offer_documents" },
    { action: "offer.release.approve", capability: "approve_offer_documents" },
  ] as const satisfies ReadonlyArray<{ action: Action; capability: string }>;

  it("verweigert Viewer auch mit positiver Capability", () => {
    for (const { action, capability } of releaseActions) {
      expect(can(ctx("viewer", { [capability]: true }), action), action).toBe(false);
    }
  });

  it("verlangt beim Editor exakt die positive Capability", () => {
    for (const { action, capability } of releaseActions) {
      expect(can(ctx("editor"), action), `${action} ohne Capability`).toBe(false);
      expect(can(ctx("editor", { [capability]: false }), action), `${action} mit false`).toBe(false);
      expect(can(ctx("editor", { [capability]: true }), action), `${action} mit true`).toBe(true);
    }
  });

  it("lässt Admins die positive Capability wie im bestehenden Modell implizieren", () => {
    for (const { action } of releaseActions) {
      expect(can(ctx("admin"), action), action).toBe(true);
    }
  });

  it("sperrt external_only für Editor und Admin fail-closed", () => {
    for (const { action, capability } of releaseActions) {
      expect(can(ctx("editor", { [capability]: true, external_only: true }), action), `${action} / editor`).toBe(false);
      expect(can(ctx("admin", { external_only: true }), action), `${action} / admin`).toBe(false);

      const malformed = {
        role: "admin",
        capabilities: { external_only: "false" },
        featureFlags: {},
      } as unknown as PermissionCtx;
      expect(can(malformed, action), `${action} / malformed external_only`).toBe(false);

      expect(can(ctx("editor", { [capability]: true, external_only: false }), action), `${action} / literal false`).toBe(true);
    }
  });

  it("verwendet kein Feature-Flag als Ersatz oder zusätzliche Freigabe", () => {
    for (const { action, capability } of releaseActions) {
      expect(can(ctx("editor", {}, { [capability]: true }), action), `${action} / Flag statt Capability`).toBe(false);
      expect(can(ctx("editor", { [capability]: true }, { [capability]: false }), action), `${action} / Capability trotz Flag false`).toBe(true);
      expect(ACTION_REQUIREMENTS[action]).not.toHaveProperty("feature");
    }
  });
});

describe("M2-03b1 Ausstellungsfassung bleibt eine interne Berechtigungsgrenze", () => {
  const issuanceActions = [
    { action: "offer.issue.prepare", capability: "prepare_offer_documents" },
    { action: "offer.issue.approve", capability: "approve_offer_documents" },
    { action: "offer.issue.withdraw", capability: "approve_offer_documents" },
  ] as const satisfies ReadonlyArray<{ action: Action; capability: string }>;

  it("verlangt mindestens Editor plus exakte Capability", () => {
    for (const { action, capability } of issuanceActions) {
      expect(can(ctx("viewer", { [capability]: true }), action), `${action} / viewer`).toBe(false);
      expect(can(ctx("editor"), action), `${action} / editor ohne Capability`).toBe(false);
      expect(can(ctx("editor", { [capability]: true }), action), `${action} / editor`).toBe(true);
      expect(can(ctx("admin"), action), `${action} / admin`).toBe(true);
    }
  });

  it("sperrt external_only auch fuer Admins und verwendet kein Feature-Flag", () => {
    for (const { action, capability } of issuanceActions) {
      expect(can(ctx("editor", { [capability]: true, external_only: true }), action), action).toBe(false);
      expect(can(ctx("admin", { external_only: true }), action), action).toBe(false);
      expect(can(ctx("editor", {}, { [capability]: true }), action), action).toBe(false);
      expect(ACTION_REQUIREMENTS[action]).not.toHaveProperty("feature");
    }
  });
});

describe("can() ist fail-closed bei kaputten Daten (Codex-Review #22)", () => {
  // membership.role ist in der DB `text`; der TS-Typ Role ist nur eine
  // Behauptung. Ein Wert wie "owner" kam vor dem Fix durch, weil
  // RANK["owner"] === undefined und `undefined < 1` false ergibt.
  it("unbekannte Rolle 'owner' verbietet ALLE Actions", () => {
    const rogue = { role: "owner", capabilities: {}, featureFlags: { invoicing: true } } as unknown as PermissionCtx;
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) {
      expect(can(rogue, a), `owner darf ${a} nicht`).toBe(false);
    }
  });

  it("leere/fehlende Rolle verbietet ALLE Actions", () => {
    for (const bad of ["", null, undefined, "ADMIN", "admin "]) {
      const rogue = { role: bad, capabilities: {}, featureFlags: { invoicing: true } } as unknown as PermissionCtx;
      for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) {
        expect(can(rogue, a), `${JSON.stringify(bad)} darf ${a} nicht`).toBe(false);
      }
    }
  });

  it("Capability als String \"true\" zählt NICHT als true (jsonb liefert beliebige Typen)", () => {
    const stringy = {
      role: "editor",
      capabilities: { invoicing: "true" },
      featureFlags: { invoicing: true },
    } as unknown as PermissionCtx;
    expect(can(stringy, "invoice.issue")).toBe(false);
  });

  it("truthy Nicht-true-Werte in Capabilities/Feature-Flags zählen nicht", () => {
    for (const truthy of ["true", 1, {}, [], "yes"]) {
      const capCtx = {
        role: "editor",
        capabilities: { see_purchase_prices: truthy },
        featureFlags: {},
      } as unknown as PermissionCtx;
      expect(can(capCtx, "price.read_purchase"), `capability ${JSON.stringify(truthy)}`).toBe(false);

      const flagCtx = {
        role: "admin",
        capabilities: { invoicing: true },
        featureFlags: { invoicing: truthy },
      } as unknown as PermissionCtx;
      expect(can(flagCtx, "invoice.issue"), `feature ${JSON.stringify(truthy)}`).toBe(false);
    }
  });

  it("unbekannte Action (Laufzeit-String) ist verboten", () => {
    expect(can(ctx("admin"), "nicht.existent" as Action)).toBe(false);
  });
});
