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
    if (entry.isDirectory()) out.push(...tsFilesRecursive(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe.skip("F13-16 Filing-Post, Audit und Servicepreise (RED, SPECIFIED — 6/6 ROT belegt)", () => {
  it("Transition mailt Outbox-Zeile: grid-submitted.v1 ist als Outbox-Template gepinnt", () => {
    // Heute: nur cannot-fulfil.v1 + portal-link.v1 (contract.ts).
    expect(CUSTOMER_NOTIFICATION_TEMPLATE_IDS as readonly string[]).toContain("grid-submitted.v1");
  });

  it("Noop-Transport akzeptiert das Filing-Template (ID-only-Aufruf)", async () => {
    // Heute: Noop wirft invalid_template fuer alles ausserhalb der 2 Pins.
    const transport = new NoopCustomerNotificationTransport();
    await expect(transport.send({
      idempotencyKey: "grid-submitted.v1:grid_registration:22222222-2222-4222-8222-222222222222:eingereicht",
      templateId: "grid-submitted.v1",
      recipient: { email: "kunde@beispiel.de" },
    })).resolves.toEqual({ sent: true });
  });

  it("Template-Key registriert: grid_submitted steht unter F16-10-Verwaltung", () => {
    // Heute: exakt 8 Keys (email-template.ts), kein Filing-Key.
    expect(isEmailTemplateKey("grid_submitted")).toBe(true);
    expect(EMAIL_TEMPLATE_KEYS as readonly string[]).toContain("grid_submitted");
  });

  it("service_price-Query existiert (modules/service-prices/service.ts)", () => {
    // Heute: SPEC-ONLY — weder Tabelle noch Modul (nur service-price.v1-Contract).
    expect(existsSync(path.join(repoRoot(), "modules", "service-prices", "service.ts"))).toBe(true);
  });

  it("Kapsel-Evidenz: Token-Chat-Post schreibt subsidy_case.message_posted", () => {
    // Heute: post_subsidy_message (drizzle/0119) schreibt weder Event noch
    // Audit — nur die Nachrichtenzeile. Fix landet per Append-Migration.
    const capsuleFiles = drizzleFiles().filter((file) =>
      readFileSync(file, "utf8").includes("post_subsidy_message"),
    );
    expect(capsuleFiles.length).toBeGreaterThan(0);
    const withEvidence = capsuleFiles.filter((file) =>
      readFileSync(file, "utf8").includes("subsidy_case.message_posted"),
    );
    expect(withEvidence).not.toEqual([]);
  });

  it("Storno storniert Queued: Filing-Storno-Kapsel existiert", () => {
    // Heute: nur _f1008_cancel_project_portal_notification; kein
    // _f1316_cancel_filing_notifications in drizzle/ oder modules/.
    const haystacks = [
      ...drizzleFiles(),
      ...tsFilesRecursive(path.join(repoRoot(), "modules")),
    ];
    const hits = haystacks.filter((file) =>
      readFileSync(file, "utf8").includes("_f1316_cancel_filing_notifications"),
    );
    expect(hits).not.toEqual([]);
  });
});
