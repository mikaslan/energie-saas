// Haupt-Barrel: NUR Domänen-Tabellen.
//
// Das Auth-Schema (lib/db/schema/auth.ts) ist hier BEWUSST NICHT enthalten
// (Codex-Review #19 + #25a): auth_user repliziert sämtliche Plattform-E-Mails
// ohne RLS. Solange die Auth-Tabellen aus diesem Barrel exportiert wurden, war
// ein vergessenes WHERE in irgendeinem Domänenmodul genau der Cross-Tenant-
// Leseweg, den die user_identity-RLS verhindern soll.
//
// Wer Auth-Tabellen braucht (nur lib/auth.ts), importiert "./schema/auth"
// direkt; dependency-cruiser erzwingt das. drizzle.config.ts kennt beide Pfade,
// damit Migrationen weiterhin ALLE Tabellen sehen.
export * from "./appointment";
export * from "./calendar";
export * from "./core";
export * from "./boards";
export * from "./catalog";
export * from "./catalog-import";
export * from "./checklist";
export * from "./checklist-template";
export * from "./crm";
export * from "./economics";
export * from "./customer-notification";
export * from "./discount-template";
export * from "./events";
export * from "./energy";
export * from "./erasure";
export * from "./intake";
export * from "./invoicing";
export * from "./lead-source";
export * from "./subsidy-template";
export * from "./offers";
export * from "./offer-release";
export * from "./payment-option";
export * from "./offer-issuance";
export * from "./project";
export * from "./project-loss-reason";
export * from "./project-assignment";
export * from "./project-note";
export * from "./project-task";
export * from "./portal";
export * from "./signatures";
export * from "./site";
export * from "./time-tracking";
