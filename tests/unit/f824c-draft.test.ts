import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DRAFT_PDF_INPUT_VERSION,
  DRAFT_PDF_RENDERER_RECIPE_VERSION,
  DRAFT_PDF_TEMPLATE_VERSION,
  buildDraftPdfInput,
  resolveDraftPdfArtifactFilename,
  type DraftPdfInputV1,
} from "@/lib/integrations/invoicing/pdf-contract";
import { renderDraftPdfHtml } from "@/lib/integrations/invoicing/draft-template";
import {
  DRAFT_PDF_DISPATCH_SCHEMA_VERSION,
  DraftPdfDispatchError,
  createDraftPdfRenderHandler,
  parseDraftPdfDispatchPayload,
} from "@/worker/draft-pdf";
import {
  DraftPdfRenderError,
  MAX_DRAFT_PDF_BYTES,
  createPlaywrightDraftPdfRenderer,
  normalizeDraftPdfMetadata,
  validateRenderedDraftPdf,
} from "@/worker/draft-pdf-renderer";

const PREPARED_AT = "2026-09-17T10:00:00.000Z";

const RECIPIENT = {
  displayName: "Muster GmbH",
  street: "Musterstrasse",
  houseNumber: "12a",
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
};

const SENDER = {
  companyName: "Energie Saas AG",
  companyEmail: "rechnung@beispiel.de",
  companyAuthority: null,
  companyRegisterNumber: null,
  companyTaxId: "DE123456789",
  companyAddressLine1: "Werftstrasse 1",
  companyAddressLine2: null,
  companyPostalCode: "20457",
  companyCity: "Hamburg",
  companyCountry: "DE",
  paymentAccountHolder: null,
  paymentIban: null,
  paymentBic: null,
  settingsRevision: 3,
};

const DOCUMENT = {
  type: "invoice",
  name: "F824C-Draft",
  invoiceKind: "schlussrechnung",
  creditNoteType: null,
  dueDate: "2026-09-24",
  serviceDate: "2026-09-01",
  skontoPercentBps: 200,
  skontoDays: 14,
};

const LINES = [
  {
    position: 1,
    title: "PV-Module",
    quantityMilli: 10_000,
    unit: "piece",
    netCents: 100_000,
    taxCents: 19_000,
    grossCents: 119_000,
    taxRateBps: 1900,
  },
];

function validOptions() {
  return {
    document: { ...DOCUMENT },
    recipient: { ...RECIPIENT },
    sender: { ...SENDER },
    lines: LINES.map((line) => ({ ...line })),
    headTotals: { netCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
    preparedAt: PREPARED_AT,
  };
}

function validInput(): DraftPdfInputV1 {
  const built = buildDraftPdfInput(validOptions());
  if (!built.ok) throw new Error(`F824C-Testsetup ungueltig: ${built.error}`);
  return built.value;
}

function syntheticChromiumPdf(metadata: string): Buffer {
  return Buffer.from(
    `%PDF-1.7\n1 0 obj<</CreationDate (${metadata})/ModDate (${metadata})>>endobj\ntrailer\n%%EOF`,
    "latin1",
  );
}

describe("F824C-CT-01: Draft-Template (ENTWURF, kein Siegel)", () => {
  it("F824C-UT-01: rendert fettes ENTWURF-Wasserzeichen je Seite", () => {
    const html = renderDraftPdfHtml(validInput());
    expect(html).toContain("ENTWURF");
    expect(html).toContain("draft-watermark");
    expect(html).toContain("Entwurf");
  });

  it("F824C-UT-02: kein Siegel-Claim, keine Hash-Aussage, keine Nummern-Zeile", () => {
    const html = renderDraftPdfHtml(validInput());
    for (const claim of ["Siegel", "siegel", "versiegelt", "Hash", "SHA-256", "rechtsverbindlich", "Belegnummer", "Ausgestellt"]) {
      expect(html).not.toContain(claim);
    }
  });

  it("F824C-UT-03: Nummern-/Datums-Luecken rendern als Gedankenstrich", () => {
    const built = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, dueDate: null, serviceDate: null },
      recipient: null,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const html = renderDraftPdfHtml(built.value);
    expect(html).toContain("–");
    expect(html).toContain("Kein Empfänger hinterlegt");
  });

  it("F824C-UT-04: dynamische Werte sind HTML-escapet", () => {
    const built = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, name: "<script>alert(1)</script>" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const html = renderDraftPdfHtml(built.value);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("F824C-UT-05: ungueltiger Input wirft TypeError (fail-closed)", () => {
    expect(() => renderDraftPdfHtml({} as never)).toThrow(TypeError);
    expect(() => renderDraftPdfHtml(null as never)).toThrow(TypeError);
  });
});

describe("F824C-CT-02: Draft-Dateiname (<name>-entwurf.pdf, Safe-Pattern)", () => {
  const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.pdf$/u;

  it("F824C-UT-06: leitet <name>-entwurf.pdf aus dem Belegnamen ab", () => {
    expect(resolveDraftPdfArtifactFilename("F824C-Draft")).toBe("F824C-Draft-entwurf.pdf");
  });

  it("F824C-UT-07: sanitisiert Sonderzeichen deterministisch", () => {
    expect(resolveDraftPdfArtifactFilename("Rechnung Müller/AG 2026")).toBe(
      "Rechnung-M-ller-AG-2026-entwurf.pdf",
    );
  });

  it("F824C-UT-08: Ergebnis besteht immer das Routen-Safe-Pattern", () => {
    for (const name of ["a", " ./\\<>", "Ünïcödé–Name ", "x".repeat(500)]) {
      expect(resolveDraftPdfArtifactFilename(name)).toMatch(SAFE);
    }
  });

  it("F824C-UT-09: wirft bei leerem Namen (fail-closed)", () => {
    expect(() => resolveDraftPdfArtifactFilename("   ")).toThrow(TypeError);
  });
});

describe("F824C-CT-01: Draft-Worker-Dispatch und Handler (schlank)", () => {
  const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
  const JOB_ID = "22222222-2222-4222-8222-222222222222";

  it("F824C-UT-10: Dispatch-Version ist gepinnt, Fremd-Payloads fail-closed", () => {
    expect(DRAFT_PDF_DISPATCH_SCHEMA_VERSION).toBe("draft-pdf-dispatch.v1");
    expect(parseDraftPdfDispatchPayload({
      schemaVersion: "draft-pdf-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })).toEqual({
      schemaVersion: "draft-pdf-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    });
    expect(() => parseDraftPdfDispatchPayload({
      schemaVersion: "invoice-pdf-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })).toThrow(DraftPdfDispatchError);
    expect(() => parseDraftPdfDispatchPayload(null)).toThrow(DraftPdfDispatchError);
  });

  it("F824C-UT-11: Handler rendert gepinntes Draft-Tripel und finalisiert Erfolg", async () => {
    const input = validInput();
    const artifact = {
      bytes: Buffer.from("draft-bytes"),
      sha256: "0".repeat(64),
      sizeBytes: 11,
      mimeType: "application/pdf" as const,
    };
    const calls: string[] = [];
    const handler = createDraftPdfRenderHandler({
      database: {
        claim: async () => ({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          leaseToken: "33333333-3333-4333-8333-333333333333",
          attemptCount: 1,
          inputVersion: DRAFT_PDF_INPUT_VERSION,
          templateVersion: DRAFT_PDF_TEMPLATE_VERSION,
          rendererRecipeVersion: DRAFT_PDF_RENDERER_RECIPE_VERSION,
          inputSha256: "f".repeat(64),
          input,
        }),
        finalizeSuccess: async () => {
          calls.push("success");
          return { state: "succeeded" };
        },
        finalizeFailure: async () => {
          calls.push("failure");
          return { state: "failed_final" };
        },
      },
      renderer: {
        render: async (value) => {
          expect(value).toEqual(input);
          return artifact;
        },
      },
    });
    await handler([{ data: { schemaVersion: "draft-pdf-dispatch.v1", workspaceId: WORKSPACE_ID, jobId: JOB_ID } }]);
    expect(calls).toEqual(["success"]);
  });

  it("F824C-UT-12: Kreuz-Tripel (Invoice-Template) wird invalid_input, nie gerendert", async () => {
    const input = validInput();
    let rendered = false;
    let failure: { errorCode: string; retryable: boolean } | null = null;
    const handler = createDraftPdfRenderHandler({
      database: {
        claim: async () => ({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          leaseToken: "33333333-3333-4333-8333-333333333333",
          attemptCount: 1,
          inputVersion: "invoice-pdf-input.v1",
          templateVersion: "invoice-pdf-template.v1",
          rendererRecipeVersion: "invoice-pdf-renderer-recipe.v1",
          inputSha256: "f".repeat(64),
          input: input as never,
        }),
        finalizeSuccess: async () => ({ state: "succeeded" }),
        finalizeFailure: async (value) => {
          failure = { errorCode: value.errorCode, retryable: value.retryable };
          return { state: "failed_final" };
        },
      },
      renderer: {
        render: async () => {
          rendered = true;
          throw new Error("darf nicht rendern");
        },
      },
    });
    await handler([{ data: { schemaVersion: "draft-pdf-dispatch.v1", workspaceId: WORKSPACE_ID, jobId: JOB_ID } }]);
    expect(rendered).toBe(false);
    expect(failure).toEqual({ errorCode: "invalid_input", retryable: false });
  });
});

describe("F824C-CT-01: Draft-Renderer (Chromium-Pfad, schlank)", () => {
  it("F824C-UT-13: ungueltiger Input scheitert vor dem Browser (fail-closed)", async () => {
    const renderer = createPlaywrightDraftPdfRenderer({ allowUnpinnedRuntimeForVerification: true });
    await expect(renderer.render({} as never)).rejects.toMatchObject({
      name: "DraftPdfRenderError",
      code: "invalid_input",
      retryable: false,
    });
  });

  it("F824C-UT-14: ungepinnte Runtime rendert nicht unter Rezept-Version", async () => {
    const renderer = createPlaywrightDraftPdfRenderer();
    const outcome = await renderer.render(validInput()).then(
      (artifact) => ({ ok: true as const, artifact }),
      (error) => ({ ok: false as const, error }),
    );
    if (process.platform === "linux" && process.arch === "x64") {
      // Gepinnte Runtime: mit echtem Chromium (CI stellt ihn bereit,
      // m202/m203a-Muster) MUSS echtes Rendern gelingen — mit
      // ENTWURF-Wasserzeichen im Byte-Strom; ohne Browser sauberer
      // DraftPdfRenderError statt Rohfehler.
      if (outcome.ok) {
        // Echter Headless-Render: PDF-Integritaet pruefen (der Content-
        // Stream kodiert Text — kein Literal-Assert; dass ENTWURF im
        // Render-Input steht, pinnt UT-01 auf HTML-Ebene).
        expect(outcome.artifact.mimeType).toBe("application/pdf");
        expect(outcome.artifact.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        expect(outcome.artifact.bytes.subarray(Math.max(0, outcome.artifact.bytes.length - 1024)).toString("latin1")).toContain("%%EOF");
        expect(createHash("sha256").update(outcome.artifact.bytes).digest("hex")).toBe(outcome.artifact.sha256);
        expect(outcome.artifact.sizeBytes).toBe(outcome.artifact.bytes.length);
      } else {
        expect(outcome.error).toBeInstanceOf(DraftPdfRenderError);
      }
    } else {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({ code: "browser_unavailable", retryable: true });
      }
    }
  });

  it("F824C-UT-15: Artefakt-Validierung schuetzt Groesse/Format/Metadaten", () => {
    expect(MAX_DRAFT_PDF_BYTES).toBe(8 * 1024 * 1024);
    expect(() => validateRenderedDraftPdf(Buffer.from("kein-pdf"), PREPARED_AT)).toThrow(DraftPdfRenderError);
    expect(() => normalizeDraftPdfMetadata(Buffer.from("x".repeat(200), "latin1"), PREPARED_AT)).toThrow(
      expect.objectContaining({ code: "invalid_pdf" }),
    );
    const valid = syntheticChromiumPdf("D:20260917090000+00'00'");
    const rendered = validateRenderedDraftPdf(valid, PREPARED_AT);
    expect(rendered.mimeType).toBe("application/pdf");
    expect(rendered.bytes.toString("latin1")).toContain("D:20260917100000+00'00'");
  });
});
