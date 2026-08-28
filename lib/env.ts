// ═══════════════════════════════════════════════════════════════════════
// Fail-Fast für sicherheitskritische Umgebungsvariablen.
//
// Anlass (Ist-Bericht 2026-08-28, Blocker 3): BETTER_AUTH_SECRET war leer,
// better-auth fiel auf sein Default-Secret zurück — und NICHTS im Repo hat
// das bemerkt. Der Build lief grün durch, die Tests ebenso (sie setzen sich
// ihr eigenes Secret), und ein Deploy in diesem Zustand wäre möglich
// gewesen. Mit bekanntem Default-Secret sind Session-Tokens fälschbar.
//
// Die Prüfung gehört NICHT in den Modul-Scope von lib/auth.ts: `next build`
// importiert dieses Modul beim Collecting page data, und ein Build ist kein
// Deploy. Sie läuft deshalb genau dann, wenn die Auth-Instanz tatsächlich
// konstruiert wird — also beim ersten echten Request.
// ═══════════════════════════════════════════════════════════════════════

// Ein zufälliges 32-Byte-Secret ist base64 44 Zeichen lang. 32 ist die
// untere Schranke, die better-auth für symmetrische Verschlüsselung
// (storeOTP: "encrypted") sinnvoll trägt.
const MIN_SECRET_LENGTH = 32;

// Werte mit dieser Kennung sehen wie ein Secret aus, sind aber keins. Der
// CI-Build und `npm run auth:generate` setzen bewusst einen solchen
// Platzhalter, damit reines Tooling ohne echtes Deploy-Secret laufen kann;
// auth:generate markiert sich deshalb wie `next build` als Build-Phase.
// Zur Laufzeit blockieren wir deshalb das ganze Praefix statt nur den exakten
// String: aendert jemand den Suffix in YAML oder package.json, bleibt der
// Platzhalter trotzdem verboten.
export const CI_BUILD_PLATZHALTER_PREFIX = "ci-build-platzhalter-";
export const CI_BUILD_PLATZHALTER = `${CI_BUILD_PLATZHALTER_PREFIX}kein-echtes-secret`;

function istTestumgebung(): boolean {
  // Vitest setzt VITEST=true; tests/db/auth.test.ts setzt sich ein eigenes,
  // ausreichend langes Secret. Die Prüfung bleibt dort also wirkungslos —
  // sie ist hier nur explizit ausgenommen, damit ein künftiger kürzerer
  // Testwert nicht plötzlich die halbe Suite rot macht.
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

// Genau dann scharf, wenn die Anwendung wirklich läuft: nicht im Build
// (next setzt NEXT_PHASE=phase-production-build), nicht im Test.
function istLaufzeit(): boolean {
  return !istTestumgebung() && process.env.NEXT_PHASE !== "phase-production-build";
}

export function requireAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET ?? "";

  if (!istLaufzeit()) return secret;

  if (secret.length === 0) {
    throw new Error(
      "BETTER_AUTH_SECRET ist nicht gesetzt. better-auth würde auf ein bekanntes " +
        "Default-Secret zurückfallen — damit sind Session-Tokens fälschbar. " +
        "Erzeugen mit: openssl rand -base64 32",
    );
  }
  if (secret.startsWith(CI_BUILD_PLATZHALTER_PREFIX)) {
    throw new Error(
      "BETTER_AUTH_SECRET ist ein CI-/Tooling-Platzhalter. Er darf einen Build " +
        "oder auth:generate grün machen, aber niemals eine laufende Instanz. " +
        "Erzeugen mit: openssl rand -base64 32",
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET ist zu kurz (${secret.length} Zeichen, mindestens ` +
        `${MIN_SECRET_LENGTH} nötig). Erzeugen mit: openssl rand -base64 32`,
    );
  }

  return secret;
}
