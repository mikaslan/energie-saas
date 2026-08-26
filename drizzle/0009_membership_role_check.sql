-- Codex-Review #22 (MUSS vor Merge): membership.role ist `text` und war bisher
-- ungeprüft. Zusammen mit dem RANK-Vergleich in lib/permissions.ts entstand
-- daraus eine echte Rechteeskalation: für role = 'owner' war RANK['owner']
-- === undefined, und `undefined < 1` ist false — die Mindestrollen-Schranke
-- ließ die Aktion also DURCH statt sie zu sperren.
--
-- Zwei Schichten, beide nötig:
--  (1) hier: die DB akzeptiert überhaupt nur die drei bekannten Rollen,
--  (2) lib/permissions.ts: `can()` lehnt unbekannte Rollen zusätzlich zur
--      Laufzeit ab (die DB ist nicht die einzige Quelle für einen ctx —
--      z. B. Import-/Migrationsskripte, künftige Sync-Pfade).
--
-- Kein Postgres-ENUM: eine spätere vierte Rolle wäre dort ein ALTER TYPE mit
-- eigenen Fallstricken (nicht in Transaktion rückrollbar in älteren Versionen);
-- ein CHECK lässt sich additiv ersetzen.
alter table membership
  add constraint membership_role_check check (role in ('viewer', 'editor', 'admin'));
