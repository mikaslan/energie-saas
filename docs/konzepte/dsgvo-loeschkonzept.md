# DSGVO-Löschkonzept (Krypto-Shredding + Pseudonymisierung)
## Problem
Append-only (domain_events, audit_log) und WORM-Belege kollidieren mit Art. 17 DSGVO.
Rechnungen sind 8 Jahre aufbewahrungspflichtig (§ 147 AO) — dort geht Aufbewahrung vor
Löschung. Notizen, Events-Payloads, Kontaktdaten außerhalb von Belegen nicht.
## Regeln (ab M1 bindend)
1. Personenbezug in Events/Audit NUR als IDs, nie als Klartext (kein Name/E-Mail im payload).
2. Kontakt-Löschung = Pseudonymisierung der contact-Zeile (Felder überschreiben mit
   "geloescht-<id>") + Löschzeitstempel; referenzielle IDs bleiben, Belege bleiben.
3. Wo Klartext in unveränderlichen Artefakten unvermeidbar ist (Beleg-PDF), gilt die
   gesetzliche Aufbewahrung als Rechtsgrundlage (Art. 17 Abs. 3 b DSGVO) — dokumentiert
   in der Datenschutzerklärung/AVV.
4. Krypto-Shredding als Ausbaustufe (pro Kontakt verschlüsselte Zusatzfelder, Schlüssel
   löschbar) wird erst eingeführt, wenn ein Modul Klartext-Personenbezug in append-only-
   Strukturen braucht — bis dahin verhindert Regel 1 das Problem an der Wurzel.
## Fristen
- Leads ohne Vertrag: Löschprüfung nach 24 Monaten Inaktivität (konfigurierbar pro Workspace).
- Bewerber-/Marketingdaten: nicht Teil des Produkts (Stand M0).
