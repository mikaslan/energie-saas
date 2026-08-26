import { describe, it, expect } from "vitest";
import { sha256Hex, immutableKey, S3Storage } from "@/lib/storage";

describe("storage", () => {
  it("sha256Hex ist deterministisch und korrekt", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
  it("immutableKey erzwingt das immutable/-Präfix", () => {
    expect(immutableKey("ws1", "offers", "abc.pdf")).toBe(
      "immutable/ws1/offers/abc.pdf"
    );
    expect(() => immutableKey("../x", "offers", "a.pdf")).toThrow();
  });
  it("immutableKey lehnt . und .. ab", () => {
    expect(() => immutableKey("..", "offers", "a.pdf")).toThrow();
    expect(() => immutableKey(".", "offers", "a.pdf")).toThrow();
    expect(() => immutableKey("ws1", "..", "a.pdf")).toThrow();
    expect(() => immutableKey("ws1", ".", "a.pdf")).toThrow();
  });
  // ═══════════════════════════════════════════════════════════════════
  // Codex-Review #10: put() und getSignedUploadUrl() akzeptierten
  // immutable/-Keys und umgingen putImmutable() damit vollständig — die
  // WORM-Zusage war reine Konvention.
  // ═══════════════════════════════════════════════════════════════════
  it("put() lehnt immutable/-Keys ab (WORM lässt sich nicht überschreiben)", async () => {
    const calls: unknown[] = [];
    const storage = new S3Storage({ bucket: "b" }, { send: async (c: unknown) => { calls.push(c); return {}; } } as never);
    await expect(
      storage.put("immutable/ws1/offers/a.pdf", Buffer.from("x"), "application/pdf")
    ).rejects.toThrow(/put\(\).*WORM|WORM.*put\(\)/);
    // Und zwar OHNE das Objekt vorher anzufassen.
    expect(calls).toHaveLength(0);
  });

  it("getSignedUploadUrl() lehnt immutable/-Keys ab (keine Upload-URL an putImmutable vorbei)", async () => {
    const calls: unknown[] = [];
    const storage = new S3Storage({ bucket: "b" }, { send: async (c: unknown) => { calls.push(c); return {}; } } as never);
    await expect(
      storage.getSignedUploadUrl("immutable/ws1/offers/a.pdf", "application/pdf")
    ).rejects.toThrow(/WORM/);
    expect(calls).toHaveLength(0);
  });

  it("mutable APIs bleiben für normale Keys erlaubt", async () => {
    const storage = new S3Storage({ bucket: "b" }, { send: async () => ({}) } as never);
    await expect(storage.put("uploads/ws1/a.pdf", Buffer.from("x"), "application/pdf")).resolves.toEqual({
      key: "uploads/ws1/a.pdf",
    });
  });

  it("putImmutable verweigert Überschreiben (Client gemockt)", async () => {
    const calls: string[] = [];
    const fakeClient = {
      send: async (cmd: { constructor: { name: string } }) => {
        calls.push(cmd.constructor.name);
        if (cmd.constructor.name === "HeadObjectCommand") return {}; // Objekt existiert bereits
        return {};
      },
    };
    const storage = new S3Storage({ bucket: "b" }, fakeClient as never);
    await expect(
      storage.putImmutable(
        "immutable/ws1/offers/a.pdf",
        Buffer.from("x"),
        "application/pdf"
      )
    ).rejects.toThrow(/existiert bereits/);
  });
  it("putImmutable nutzt IfNoneMatch zur TOCTOU-Abwehr", async () => {
    const commands: unknown[] = [];
    const fakeClient = {
      send: async (cmd: unknown) => {
        commands.push(cmd);
        // Simulate 404 Not Found for HeadObject
        const c = cmd as { constructor: { name: string } };
        if (c.constructor.name === "HeadObjectCommand") {
          const error = new Error("Not Found") as { $metadata?: { httpStatusCode?: number }; name?: string };
          error.$metadata = { httpStatusCode: 404 };
          error.name = "NotFound";
          throw error;
        }
        return {};
      },
    };
    const storage = new S3Storage({ bucket: "b" }, fakeClient as never);
    await storage.putImmutable(
      "immutable/ws1/offers/new.pdf",
      Buffer.from("data"),
      "application/pdf"
    );
    // Verify PutObjectCommand includes IfNoneMatch
    const putCmd = commands.find((c: unknown) => {
      const cmd = c as { constructor?: { name?: string }; input?: { IfNoneMatch?: string } };
      return cmd.constructor?.name === "PutObjectCommand";
    }) as { input?: { IfNoneMatch?: string } };
    expect(putCmd).toBeDefined();
    expect(putCmd?.input?.IfNoneMatch).toBe("*");
  });
});
