import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat, type HealthProbe } from "../../worker/health";

// Dead-Man-Switch-Vertrag (docs/tooling/entscheidungen.md §15 + Codex-Review
// #3-#5): Ping NUR nach erfolgreicher Probe; Ticks überlappen nie (nächster
// erst nach Abschluss des vorherigen); nach stop() pingt auch ein laufender
// Tick nicht mehr; ein Nicht-2xx ist keine Zustellung und wird geloggt;
// Fetch-Fehler dürfen weder werfen noch den Takt stoppen.

function fakeProbe(impl: () => Promise<void>): HealthProbe {
  return {
    probe: impl,
    stats: () => ({ total: 0, idle: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

const okProbe = () => fakeProbe(() => Promise.resolve());

describe("startHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pingt sofort und dann je Intervall, solange die Probe gesund ist", async () => {
    const fetchFn = vi.fn(async () => new Response("ok"));
    const stop = startHeartbeat(okProbe(), "https://hc.example/ping", 60_000, fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn).toHaveBeenCalledWith("https://hc.example/ping", expect.anything());
    stop();
  });

  it("unterdrückt den Ping, wenn die Probe fehlschlägt (Dead-Man-Semantik)", async () => {
    let broken = false;
    const fetchFn = vi.fn(async () => new Response("ok"));
    const probe = fakeProbe(() => (broken ? Promise.reject(new Error("db weg")) : Promise.resolve()));
    const stop = startHeartbeat(probe, "https://hc.example/ping", 60_000, fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    broken = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1); // kein Ping trotz Tick

    broken = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2); // Erholung pingt wieder
    stop();
  });

  it("überlappt nie: bei hängendem Ping startet kein weiterer Tick", async () => {
    let release!: () => void;
    const hanging = new Promise<Response>((resolve) => {
      release = () => resolve(new Response("ok"));
    });
    const fetchFn = vi.fn(() => hanging);
    const stop = startHeartbeat(okProbe(), "https://hc.example/ping", 60_000, fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Drei Intervalle vergehen, der erste Fetch hängt weiter: kein zweiter Aufruf.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Erst nach Auflösung wird der nächste Tick geplant und feuert ein Intervall später.
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    stop();
  });

  it("pingt nicht mehr, wenn stop() während einer laufenden Probe kommt", async () => {
    let release!: () => void;
    const hangingProbe = fakeProbe(
      () => new Promise<void>((resolve) => (release = () => resolve())),
    );
    const fetchFn = vi.fn(async () => new Response("ok"));
    const stop = startHeartbeat(hangingProbe, "https://hc.example/ping", 60_000, fetchFn);

    await vi.advanceTimersByTimeAsync(0); // Tick läuft, hängt in der Probe
    stop();
    release();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("wertet Nicht-2xx als Nicht-Zustellung und loggt (healthchecks.io 404/429/5xx)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response("gone", { status: 404 }));
    const stop = startHeartbeat(okProbe(), "https://hc.example/ping", 60_000, fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 404"));
    stop();
  });

  it("überlebt einen nicht erreichbaren Monitoring-Dienst und stoppt sauber", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => {
      throw new Error("hc down");
    });
    const stop = startHeartbeat(okProbe(), "https://hc.example/ping", 60_000, fetchFn);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn.mock.calls.length).toBeGreaterThan(0); // geworfen hat nichts

    stop();
    const before = fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchFn.mock.calls.length).toBe(before); // nach stop() kein Tick mehr
  });
});
