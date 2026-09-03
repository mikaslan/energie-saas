// Client-/server-sicherer Contract lebt kanonisch unter
// `lib/integrations/contacts/contract.ts` (Hausmuster notes/calendar):
// Client-Komponenten dürfen NICHT über den Modul-Barrel (server-only) laufen.
export * from "@/lib/integrations/contacts/contract";
