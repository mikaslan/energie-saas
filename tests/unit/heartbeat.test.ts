import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat, type HealthProbe } from "../../worker/health";

// Dead-Man-Switch-Vertrag (docs/tooling/entscheidungen.md §15): Ping NUR nach
// erfolgreicher Probe; bei kaputter Probe wird der Ping unterdrückt, damit das
// Ausbleiben beim Monitoring-Dienst den Alarm auslöst. Fetch-Fehler dürfen
// weder werfen noch den Takt stoppen.

function fakeProbe(fail: () => boolean): HealthProbe {
  return {
    probe: () => (fail() ? Promise.reject(new Error("db weg")) : Promise.resolve()),
    stats: () => ({ total: 0, idle: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

describe("startHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pingt sofort und dann je Intervall, solange die Probe gesund ist", async () => {
    const pings: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      pings.push(String(url));
      return new Response("ok");
    });
    const stop = startHeartbeat(fakeProbe(() => false), "https://hc.example/ping", 60_000, fetchFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(pings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pings).toHaveLength(3);
    expect(pings[0]).toBe("https://hc.example/ping");
    stop();
  });

  it("unterdrückt den Ping, wenn die Probe fehlschlägt (Dead-Man-Semantik)", async () => {
    let broken = false;
    const fetchFn = vi.fn(async () => new Response("ok"));
    const stop = startHeartbeat(fakeProbe(() => broken), "https://hc.example/ping", 60_000, fetchFn);

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

  it("überlebt einen nicht erreichbaren Monitoring-Dienst und stoppt sauber", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("hc down");
    });
    const stop = startHeartbeat(fakeProbe(() => false), "https://hc.example/ping", 60_000, fetchFn);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn.mock.calls.length).toBeGreaterThan(0); // geworfen hat nichts

    stop();
    const before = fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchFn.mock.calls.length).toBe(before); // nach stop() kein Tick mehr
  });
});
