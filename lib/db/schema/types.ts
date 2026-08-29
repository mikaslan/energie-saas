import { customType } from "drizzle-orm/pg-core";

// drizzle-orm 0.45 liefert keinen eigenen bytea-Builder. Der Treiber gibt
// bytea als Buffer zurück; die DB-CHECKs erzwingen die jeweilige Länge.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
