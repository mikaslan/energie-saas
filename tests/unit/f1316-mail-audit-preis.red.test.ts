import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EMAIL_TEMPLATE_KEYS, isEmailTemplateKey } from "@/lib/email-template";
import { CUSTOMER_NOTIFICATION_TEMPLATE_IDS } from "@/lib/integrations/notifications/contract";
import { NoopCustomerNotificationTransport } from "@/lib/integrations/notifications/resend-transport";

// F13-16 Filing-Post, Audit und Servicepreise (RED, Ref
// docs/spec/F13-16-filing-mail-audit-preis.md): NUR existierende Imports —
// kein Import aus noch nicht geschriebenem Code. ROT-Beleg per
// `npx vitest run tests/unit/f1316-mail-audit-preis.red.test.ts`
// (6 rote Tests, Auszug in der Spec); danach describe.skip bis zur Umsetzung.
// SKIP-Grund: SPECIFIED, nicht implementiert (Outbox-Pins + CHECK/UQ,
// F16-10-Keys, service_price-Modul, Kapsel-Evidenz, Storno-Kapsel — alle
// SPEC-ONLY auf diesem Branch, kein SQL) — Ref F13-16 §§1-6.

function repoRoot(): string {
  return path.resolve(process.cwd());
}

function drizzleFiles(): string[] {
  const dir = path.join(repoRoot(), "drizzle");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => path.join(dir, name));
}

function tsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...tsFilesRecursive(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe.skip("F13-16 Filing-Post, Audit und Servicepreise (RED, SPECIFIED — 6/6 ROT belegt)", () => {
  it("Transition mailt Outbox-Zeile: grid-submitted.v1 ist als Outbox-Template gepinnt", () => {
    expect(CUSTOMER_NOTIFICATION_TEMPLATE_IDS).toContain("grid-submitted.v1");
  });

  it("Noop-Transport akzeptiert das Filing-Template (ID-only-Aufruf)", async () => {
    const transport = new NoopCustomerNotificationTransport();
    const result = await transport.send({
      idempotencyKey: "grid-submitted.v1:grid_registration:00000000-0000-0000-0000-000000000000:eingereicht",
      templateId: "grid-submitted.v1",
      recipient: { email: "kunde@example.test" },
    });
    expect(result.sent).toBe(true);
  });

  it("Template-Key registriert: grid_submitted steht unter F16-10-Verwaltung", () => {
    expect(EMAIL_TEMPLATE_KEYS).toContain("grid_submitted");
    expect(isEmailTemplateKey("grid_submitted")).toBe(true);
  });

  it("service_price-Query existiert (modules/service-prices/service.ts)", () => {
    const serviceFile = path.join(
      repoRoot(),
      "modules",
      "service-prices",
      "service.ts",
    );
    expect(existsSync(serviceFile)).toBe(true);
    const candidates = tsFilesRecursive(path.join(repoRoot(), "modules")).filter(
      (file) => file.endsWith("service-prices/service.ts"),
    );
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("Kapsel-Evidenz: Token-Chat-Post schreibt subsidy_case.message_posted", () => {
    const chatMigration = path.join(
      repoRoot(),
      "drizzle",
      "0119_f13_10_subsidy_chat.sql",
    );
    const content = readFileSync(chatMigration, "utf8");
    expect(content).toContain("message_posted");
  });

  it("Storno storniert Queued: Filing-Storno-Kapsel existiert", () => {
    const hits = drizzleFiles().filter((file) =>
      readFileSync(file, "utf8").includes("_f1316_cancel_filing_notifications"),
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});
