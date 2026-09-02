# ADR 0018: Cannot Fulfil als Transactional Outbox statt Direktversand

- Status: angenommen (rekonstruiert); Implementierung im verlorenen Worktree, nicht abgenommen
- Datum: 2026-09-02 (Rekonstruktion)
- Bezug: `docs/spec/M1-11b-cannot-fulfil.md`

> **Rekonstruktionswarnung.** Diese ADR rekonstruiert die Entscheidung aus der
> Vault-Beschreibung `24-Arbeitsstand-M1-11b.md` (Zeilen als `V24:N`) und
> Abschnitt 11 der Übergabe `22-Claude-Code-Handoff-M1-12a.md` (`H22:N`). Der
> Original-Arbeitsordner existiert nicht mehr.

## Kontext

`cannot_fulfill` ist ein fachlich endgültiger Outcome-Zustand mit
irreversiblen Nebenwirkungen auf Kundenkommunikation und Angebotsausstellung.
Die Übergabe verlangt deshalb ausdrücklich, Cannot Fulfil **nie** als bloßen
Statuswechsel zu liefern: zwingend sind Transactional Outbox,
Kundenbenachrichtigungszustellung, idempotente Delivery-/Retry-Evidenz und eine
Sperre gegen Signatur/Ausstellung [H22:293–301]. ADR 0016 hatte bereits
festgehalten, dass eine irreversible UI-Aktion ohne atomare Kundenmail und
Signatursperre „fachlich falsch und gefährlich“ wäre [ADR 0016, „Verworfen:
Cannot fulfill ohne Delivery-Vertrag“].

Ein Direktversand der Kundenmail aus der Transition heraus hätte drei
strukturelle Mängel: (1) der Mailversand liefe innerhalb einer offenen
DB-Transaktion und würde sie extern blockieren bzw. bei Rollback nicht
nachvollziehbar sein; (2) ein Wiederholungsversuch nach Timeout wäre nicht
idempotent und ohne protokollierte Evidenz; (3) der Worker darf die für die
Zustellung nötigen `project`/`contact`-Relationen laut Rollenvertrag (ADR 0003)
nicht direkt lesen [V24:84–85,119].

## Optionen

1. **Direktversand im Service** — Mailaufruf synchron in der
   Outcome-Transaktion.
2. **Transactional Outbox + pgboss** — Outbox-Zeile und Dispatch-Job entstehen
   in derselben Transaktion; ein Worker liefert idempotent aus.
3. **Separater Delivery-Service mit eigener Queue, ohne DB-Outbox** —
   fachliche Zustellwahrheit außerhalb der Datenbank.
4. **Bloßer Statuswechsel ohne Benachrichtigung** — wie von ADR 0016 als
   gefährlich verworfen.

## Entscheidung

Cannot Fulfil wird als **Transactional Outbox** umgesetzt. Die Transition
schreibt Project-Update, Outbox-Zeile (`customer_notification`) und den
Dispatch-Job in **derselben** Transaktion; der Einstieg
`pgboss.enqueue_customer_notification` folgt dem Muster der Migration 0035
(`pgboss.enqueue_offer_issuance`), Queue `notification.customer`
[V24:86–87,104–105].

Die Outbox speichert **keine PII**: weder Empfängeradresse noch Mailtext werden
persistiert; der Empfänger wird zum Zustellzeitpunkt live aus dem
Contact-Graphen aufgelöst [V24:73–74]. Die Zustellung protokolliert jede
Zustellung als append-only Versuchszeile in
`customer_notification_delivery_attempt` mit klassifizierten Retry-Fehlern und
idempotentem Doppel-Dispatch-Schutz [V24:70–71,96–97,150].

Der Zustand ist **terminal** (kein Reopen). Ein verbindlich ausgestelltes
Angebot (Approval ohne Withdrawal) blockiert die Transition über die schmale
Definer-Kapsel `_m111b_project_has_binding_issuance(uuid, uuid)` [V24:192–193,
227–228]. Vier Freeze-Trigger — nur auf INSERT, über vier Angebotstabellen —
verhindern, dass unter einem geschlossenen Projekt Freigabekandidaten,
Genehmigungen oder Ausstellungen entstehen [V24:74–77].

Weil `app_worker` bewusst keine Tabellenrechte auf `project`/`contact` besitzt,
erfolgt der Worker-Zugriff ausschließlich über drei SECURITY-DEFINER-Kapseln
[V24:84–85]. Die Erasure wird in `erase_inactive_lead` quellgepinnt erweitert:
Notification-Zeilen des Contact-Graphen werden mitgelockt und `queued` zu
`cancelled_contact_erased` storniert [V24:81–83].

## Konsequenzen

- Die Zustellung wird atomar zum Fach-Outcome: kein „Absage ohne Mail“ und kein
  „Mail ohne Absage“.
- Retries sind idempotent und nachvollziehbar; jede Versuchszeile ist
  append-only.
- Der DB-Guard ist die einzige autoritative Stelle gegen Ausstellung nach
  Absage, weil der Genehmigungspfad die Issuance-Relationen nicht sieht
  [V24:195–198].
- Erasure bleibt mit der Zustellung kohärent: eine gewonnene Erasure rollt
  Outcome, Outbox und Evidenz zurück [V24:152–154].
- Kein Reopen: Nach einer zugestellten Absage ist Wiedereröffnung ein eigener
  fachlicher Vorgang [V24:225–226].

## Security-Auswirkungen

- Beide Outbox-Tabellen tragen RLS, FORCE RLS, Tenant-Policy und
  Mutationsguards [V24:71–72].
- **Datensparsamkeit:** keine Empfänger- oder Inhalts-PII in der Datenbank
  [V24:73–74].
- Worker-Zugriff nur über SECURITY-DEFINER-Kapseln statt breiter Tabellengrants
  auf `project`/`contact` [V24:84–85].
- Viewer/External/Fremdmandant bleiben fail-closed, ohne dass eine Outbox-Zeile
  entsteht [V24:144–145].
- Freeze-Trigger schließen die Ausstellungslücke nach Absage; sie lassen den
  Erasure-DELETE-Pfad offen [V24:76–77,157].
- Erasure-TOCTOU (Löschung zwischen Empfängerauflösung und Versand) wird durch
  Lock + Storno statt einer reinen Nachprüfung geschlossen [V24:81–83,120].

## Datenmigration

Migration `0040_m1_11b_cannot_fulfil.sql` (768 Zeilen) [V24:68]:

- zwei neue Tabellen (`customer_notification`, `customer_notification_delivery_attempt`),
- vier Freeze-Trigger (INSERT) auf vier Angebotstabellen,
- drei **quellgepinnte** Ersetzungen der M1-11a-Funktionen (Transition-Guard,
  Evidenz-Trigger, Evidenz-Whitelist); jede prüft exakten SHA-256 und genau
  einen eindeutigen Anker, sonst bricht die Migration ab [V24:78–80],
- quellgepinnte Erweiterung von `erase_inactive_lead` [V24:81–83],
- drei Worker-SECURITY-DEFINER-Kapseln und die Runtime-Kapsel
  `_m111b_project_has_binding_issuance` [V24:84–85,192–193],
- `pgboss.enqueue_customer_notification` und Queue `notification.customer`
  [V24:86–87,104–105],
- Rollenvertrags- und pgboss-Bootstrap-Pins (`scripts/db-role-contract.mts`,
  `scripts/pgboss-bootstrap.mts`) [V24:103–105].

## Rollback-Pfad

- Die Migration ist **additiv**; ein Deploy-Rollback ist ein Code-Rollback, die
  Datenbank bleibt vorwärts migriert. Keine bereits angewandte Migration wird
  geändert (Architektur-Invariante).
- Fachlich ist `cannot_fulfill` bewusst terminal; es gibt keinen
  „Rückweg“-Command. Ein versehentlicher Abschluss wird über den bestehenden
  DSGVO-Erasurepfad bzw. einen künftigen, separat spezifizierten Vorgang
  behandelt — nicht über ein stilles Reopen [V24:225–226].
- Notifications werden nie physisch gelöscht; Storno erfolgt als
  Statusübergang `queued → cancelled_contact_erased` [V24:82–83,146].
- Die quellgepinnten Funktionsersetzungen machen einen halb angewandten Stand
  laut scheiternd statt still zu verändern [V24:78–80].

## Verworfen

### Direktversand im Service
- **Pros:** einfach, ein Aufruf.
- **Cons:** hält eine DB-Transaktion offen, kein Retry-/Idempotenznachweis,
  Rollback-Verhalten undurchsichtig.
- **Warum nicht:** verletzt „atomar, idempotent, evidenziert“ und die
  Worker-Grenze aus ADR 0003 [V24:84–85].

### Separater Delivery-Service ohne DB-Outbox
- **Pros:** entkoppelt.
- **Cons:** zweite fachliche Zustellwahrheit außerhalb der Datenbank, eigener
  Konsistenz-/Recovery-Vertrag, höhere Betriebskomplexität im modularen
  Monolithen.
- **Warum nicht:** kein Beleg, dass die zusätzliche Komplexität den
  Transaktions-/Erasure-Zusammenhang aufwiegt.

### Bloßer Statuswechsel ohne Benachrichtigung/Sperre
- **Pros:** minimaler Aufwand.
- **Cons:** fachlich falsch und gefährlich; bereits ADR 0016 verworfen.
- **Warum nicht:** die Übergabe verbietet es ausdrücklich [H22:293–301].

### PII (Empfänger/Mailtext) in der Outbox speichern
- **Pros:** einfachere Zustellung, Historie des Wortlauts.
- **Cons:** DSGVO-/Erasure-Risiko, unnötige Datenhaltung.
- **Warum nicht:** Datensparsamkeit; Empfänger wird live aufgelöst [V24:73–74].

### Reopen nach `cannot_fulfill`
- **Pros:** versehentliche Abschlüsse wären korrigierbar.
- **Cons:** würde eine zugestellte Absage inhaltlich relativieren; die
  öffentliche Semantik ist unbelegt.
- **Warum nicht:** als `DECIDED WMEE` terminal gesetzt und als `UNK-F1-05`
  geführt [V24:225–226].
