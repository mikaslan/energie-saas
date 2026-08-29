import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RequestsError from "@/app/w/[workspaceId]/anfragen/error";
import RequestsLoading from "@/app/w/[workspaceId]/anfragen/loading";
import ProjectDetailError from "@/app/w/[workspaceId]/anfragen/[projectId]/error";
import ProjectDetailLoading from "@/app/w/[workspaceId]/anfragen/[projectId]/loading";
import ProjectDetailNotFound from "@/app/w/[workspaceId]/anfragen/[projectId]/not-found";

describe("M1-05 UI-Zustände", () => {
  it("kennzeichnet das ladende Anfrage-Board semantisch", () => {
    const html = renderToStaticMarkup(createElement(RequestsLoading));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Anfrage-Board wird geladen");
  });

  it("kennzeichnet die ladende Projektakte semantisch und bewegungsarm", () => {
    const html = renderToStaticMarkup(createElement(ProjectDetailLoading));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Projektakte wird geladen"');
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("zeigt einen generischen Boardfehler ohne interne Fehlermeldung", () => {
    const html = renderToStaticMarkup(createElement(RequestsError, {
      error: new Error("vertraulicher interner Fehler"),
      retry: () => undefined,
    }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("Board nicht verfügbar");
    expect(html).toContain("Erneut versuchen");
    expect(html).not.toContain("vertraulicher interner Fehler");
  });

  it("zeigt einen generischen Projektfehler ohne Digest oder Fehlermeldung", () => {
    const error = Object.assign(new Error("vertraulicher Projektfehler"), {
      digest: "privater-digest",
    });
    const html = renderToStaticMarkup(createElement(ProjectDetailError, {
      error,
      retry: () => undefined,
    }));

    expect(html).toContain("Unerwarteter Fehler");
    expect(html).toContain("Erneut versuchen");
    expect(html).not.toContain("vertraulicher Projektfehler");
    expect(html).not.toContain("privater-digest");
  });

  it("erklärt den sicheren 404-Zustand ohne Existenzbehauptung", () => {
    const html = renderToStaticMarkup(createElement(ProjectDetailNotFound));

    expect(html).toContain("404 · Nicht gefunden");
    expect(html).toContain("existiert nicht, wurde entfernt oder gehört nicht");
  });
});
