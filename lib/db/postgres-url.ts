const ALLOWED_QUERY_PARAMETERS = new Map<string, ReadonlySet<string>>([
  ["sslmode", new Set(["verify-full"])],
]);

const AMBIENT_POSTGRES_OVERRIDES = [
  "PGUSER",
  "PGDATABASE",
  "PGPORT",
  "PGHOST",
  "PGPASSWORD",
  "PGBINARY",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGCLIENT_ENCODING",
  "PGCLIENTENCODING",
  "PGREPLICATION",
  "PGAPPNAME",
  "PGCONNECT_TIMEOUT",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export interface PostgresConnectionTarget {
  host: string;
  port: string;
  database: string;
}

export interface PostgresConnectionTransport {
  connectionString: string;
  ssl?: { rejectUnauthorized: true };
}

function isLoopbackHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1") return true;

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/**
 * Parst eine Dienst- oder Migrations-URL ohne die mehrdeutige libpq-Regel,
 * nach der Queryparameter wie `user`, `password` oder `host` die Authority
 * überschreiben können. Der einzige erlaubte Parameter erzwingt bei allen
 * nicht lokalen Zielen Zertifikats- UND Hostnamenprüfung. `sslmode=require`
 * reicht dafür nicht; `channel_binding` ist in node-postgres kein wirksamer
 * URL-Schalter und wird deshalb nicht als Scheinsicherheit akzeptiert.
 */
export function parsePostgresConnectionUrl(label: string, raw: string): URL {
  if (/[\u0000-\u0020\u007f]/.test(raw)) {
    throw new Error(`${label} darf keine rohen Leer-/Steuerzeichen enthalten.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} ist keine gültige Postgres-URL.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${label} ist keine gültige Postgres-URL.`);
  }
  if (
    !url.username ||
    !url.password ||
    !url.hostname ||
    !url.port ||
    !url.pathname.replace(/^\//, "")
  ) {
    throw new Error(`${label} ist keine vollständige Postgres-URL.`);
  }
  if (url.hash) {
    throw new Error(`${label} darf keinen URL-Fragmentteil enthalten.`);
  }

  const seen = new Set<string>();
  for (const [rawName, rawValue] of url.searchParams) {
    const name = rawName.toLowerCase();
    const allowedValues = ALLOWED_QUERY_PARAMETERS.get(name);
    if (
      rawName !== name ||
      !allowedValues ||
      seen.has(name) ||
      rawValue !== rawValue.toLowerCase() ||
      !allowedValues.has(rawValue)
    ) {
      throw new Error(
        `${label} enthält nicht erlaubte oder mehrdeutige Queryparameter; ` +
          "zulässig ist ausschließlich sslmode=verify-full.",
      );
    }
    seen.add(name);
  }

  if (!isLoopbackHost(url.hostname) && url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error(`${label} muss für ein nicht lokales Ziel sslmode=verify-full erzwingen.`);
  }

  return url;
}

export function assertNoAmbientPostgresOverrides(label: string): void {
  const present = AMBIENT_POSTGRES_OVERRIDES.filter((name) => process.env[name]);
  if (present.length > 0) {
    throw new Error(
      `${label} darf nicht durch ambient gesetzte Postgres-/TLS-Variablen ` +
        `beeinflusst werden: ${present.join(", ")}`,
    );
  }
}

/**
 * Entfernt den bereits validierten sslmode-Schalter aus der URL und bindet
 * die Zertifikatsprüfung stattdessen explizit an die echte node-postgres-
 * Konfiguration. pg-connection-string würde `sslmode=verify-full` sonst nur
 * als leeres `ssl={}` abbilden; `NODE_TLS_REJECT_UNAUTHORIZED=0` könnte dann
 * den Node-Default außerhalb dieser Konfiguration abschalten.
 */
export function postgresConnectionTransport(
  label: string,
  raw: string,
): PostgresConnectionTransport {
  const url = parsePostgresConnectionUrl(label, raw);
  const verifyTls = url.searchParams.get("sslmode") === "verify-full";
  url.search = "";
  return {
    connectionString: url.toString(),
    ...(verifyTls ? { ssl: { rejectUnauthorized: true as const } } : {}),
  };
}

export function postgresConnectionTarget(url: URL): PostgresConnectionTarget {
  return {
    host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
    port: url.port || "5432",
    // node-postgres/pg-connection-string nutzt hierfür decodeURI (nicht
    // decodeURIComponent) und behandelt Datenbanknamen case-sensitiv. Der
    // Safety-Key muss exakt dieselbe Zielsemantik abbilden.
    database: decodeURI(url.pathname.replace(/^\//, "")),
  };
}

export function postgresConnectionTargetKey(url: URL): string {
  const target = postgresConnectionTarget(url);
  return JSON.stringify({
    ...target,
    // localhost, ::1 und das gesamte 127/8 sind für Destruktiv-Safety
    // dasselbe lokale Ziel. Unterschiedliche Schreibweisen dürfen die
    // Dev-/Test-Gleichheitsprüfung nicht umgehen.
    host: isLoopbackHost(target.host) ? "loopback" : target.host,
  });
}

export function postgresTestTargetConfirmation(url: URL): string {
  const target = postgresConnectionTarget(url);
  return (
    `${target.host}:${target.port}/${encodeURIComponent(target.database)}` +
    ":ALLOW-DESTRUCTIVE-TESTS"
  );
}

export function assertDestructiveTestDatabase(label: string, url: URL): void {
  const target = postgresConnectionTarget(url);
  if (!/(?:^|[_-])test(?:$|[_-])/i.test(target.database)) {
    throw new Error(
      `${label} ist ausschließlich für Datenbanknamen mit einem klar abgegrenzten ` +
        `"test"-Segment (z. B. app_test) erlaubt.`,
    );
  }
  const expected = postgresTestTargetConfirmation(url);
  if (process.env.POSTGRES_TEST_TARGET_CONFIRM !== expected) {
    throw new Error(
      `${label} braucht eine exakte Zielbestätigung: ` +
        `POSTGRES_TEST_TARGET_CONFIRM muss ${expected} sein.`,
    );
  }
}
