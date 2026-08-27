import { describe, it, expect, afterEach, vi } from "vitest";
import { sendAuthMail } from "@/lib/mail";

// Codex-Review #20: ohne RESEND_API_KEY landeten Magic Links/OTPs auch in
// Produktion im Klartext im Log — und better-auth meldete "Versand ok".

const ORIGINAL_KEY = process.env.RESEND_API_KEY;

// vi.stubEnv setzt/entfernt Werte und macht sie mit unstubAllEnvs wieder
// rückgängig — auch für NODE_ENV, das in den Node-Typen readonly ist.
function setNodeEnv(value: string) {
  vi.stubEnv("NODE_ENV", value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_KEY;
});

describe("sendAuthMail: Produktions-Fehlkonfiguration", () => {
  it("wirft in production ohne RESEND_API_KEY statt den Link zu loggen", async () => {
    setNodeEnv("production");
    delete process.env.RESEND_API_KEY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(sendAuthMail("opfer@example.test", "Login", "https://app/magic?token=geheim")).rejects.toThrow(
      /Mail nicht konfiguriert/,
    );
    // Und zwar OHNE den Link vorher ins Log zu schreiben.
    expect(log).not.toHaveBeenCalled();
  });

  it("loggt außerhalb von production weiterhin (lokale Entwicklung bleibt möglich)", async () => {
    setNodeEnv("development");
    delete process.env.RESEND_API_KEY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(sendAuthMail("dev@example.test", "Login", "code 123456")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  it("auch bei NODE_ENV=test wird geloggt, nicht geworfen", async () => {
    setNodeEnv("test");
    delete process.env.RESEND_API_KEY;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(sendAuthMail("t@example.test", "Login", "code")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });
});
