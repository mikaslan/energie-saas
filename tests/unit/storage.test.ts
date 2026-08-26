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
});
