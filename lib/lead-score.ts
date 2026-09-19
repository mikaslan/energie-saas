// F1-07 Lead-Score (Regel-Score v1, ESTIMATE), F1-21 Vertiefung.
//
// Katalog: "AI Lead Score 0-100 (asynchron, Ampel, Filter-Presets, Signale)".
// v1 ist ein deterministischer Regel-Score über bereits vorhandene,
// revisionierte Daten (Kontakt/Site/Energieprofil/Bedarf/Zuweisung/Quelle) —
// kein ML-Modell. F1-21 ergänzt das 10. Signal „Kundenaktivität" (ESTIMATE,
// Gewicht 10) und persistiert den Score als Score-at-rest (Spalten auf
// project, Async-Worker lead.score.recompute.v1, TTL 15 Minuten). Summe über
// 10 Signale → Clamp min(100,·); Bänder fix (hot≥70/warm≥40, Ampel
// unverändert). Der synchrone Pfad bleibt als Cold-Start-Fallback bestehen.
// Gewichte und Schwellen sind reversible Näherungen (ESTIMATE); echte
// Reonic-Parität der Gewichtung braucht deren Referenzdaten.
export const LEAD_SCORE_WEIGHTS = {
  email: 10,
  phone: 10,
  address: 10,
  geo: 10,
  profile: 20,
  profileConfirmed: 10,
  requirements: 15,
  keyAccount: 10,
  source: 5,
  intent: 10,
} as const;

export type LeadScoreSignal = keyof typeof LEAD_SCORE_WEIGHTS;

export type LeadScoreBand = "hot" | "warm" | "cold";

export type LeadScoreInput = {
  hasEmail: boolean;
  hasPhone: boolean;
  hasAddress: boolean;
  hasGeo: boolean;
  hasProfile: boolean;
  profileConfirmed: boolean;
  hasRequirements: boolean;
  hasKeyAccount: boolean;
  hasSource: boolean;
  // F1-21: Kundenaktivität (EXISTS über Portalaufruf, Termin,
  // Signaturaufruf, Datei-Upload — kundeninitiiert, kein Tracking).
  hasIntent: boolean;
};

export type LeadScore = {
  value: number;
  band: LeadScoreBand;
  signals: LeadScoreSignal[];
};

// F1-21 Score-at-rest: Persistenzstatus je Projekt (NULL = nie berechnet).
export type LeadScoreStatus = "pending" | "ready";

// F1-21: Angezeigter Score je Karte — gespeicherter Wert (frisch) oder
// synchroner Fallback (stale → Badge „wird aktualisiert" + Refresh).
export type LeadScoreSnapshot = LeadScore & {
  stale: boolean;
  computedAt: string | null;
};

// F1-21: Frische-Fenster des gespeicherten Scores (15 Minuten).
export const LEAD_SCORE_STALE_AFTER_MS = 15 * 60 * 1000;

export const LEAD_SCORE_BAND_LABEL: Record<LeadScoreBand, string> = {
  hot: "Heiß",
  warm: "Warm",
  cold: "Kalt",
};

export const LEAD_SCORE_SIGNAL_LABEL: Record<LeadScoreSignal, string> = {
  email: "E-Mail vorhanden",
  phone: "Telefon erreichbar",
  address: "PLZ und Ort vorhanden",
  geo: "Standort geokodiert",
  profile: "Energieprofil vorhanden",
  profileConfirmed: "Energieprofil bestätigt",
  requirements: "Bedarfsangaben vorhanden",
  keyAccount: "Hauptverantwortung zugewiesen",
  source: "Herkunft zugeordnet",
  intent: "Kundenaktivität vorhanden",
};

const BAND_ORDER: LeadScoreSignal[] = [
  "email",
  "phone",
  "address",
  "geo",
  "profile",
  "profileConfirmed",
  "requirements",
  "keyAccount",
  "source",
  "intent",
];

const KNOWN_SIGNALS = new Set<string>(BAND_ORDER);

export function isLeadScoreSignal(value: unknown): value is LeadScoreSignal {
  return typeof value === "string" && KNOWN_SIGNALS.has(value);
}

export function scoreBandForValue(value: number): LeadScoreBand {
  if (value >= 70) return "hot";
  if (value >= 40) return "warm";
  return "cold";
}

export function computeLeadScore(input: LeadScoreInput): LeadScore {
  const met: Record<LeadScoreSignal, boolean> = {
    email: input.hasEmail,
    phone: input.hasPhone,
    address: input.hasAddress,
    geo: input.hasGeo,
    profile: input.hasProfile,
    // „Bestätigt" zählt nur mit vorhandenem Profil (kein Phantom-Signal).
    profileConfirmed: input.hasProfile && input.profileConfirmed,
    requirements: input.hasRequirements,
    keyAccount: input.hasKeyAccount,
    source: input.hasSource,
    intent: input.hasIntent,
  };
  const signals = BAND_ORDER.filter((signal) => met[signal]);
  // F1-21: 10 Signale summieren auf max. 110 → Clamp auf 100, Bänder fix.
  const raw = signals.reduce((sum, signal) => sum + LEAD_SCORE_WEIGHTS[signal], 0);
  const value = Math.min(100, raw);
  return { value, band: scoreBandForValue(value), signals };
}

// F1-21 Stale-Regel: pending (oder nie berechnet) ist immer stale; ready ist
// stale, sobald computed_at fehlt, unparsbar ist oder älter als TTL ist.
export function isLeadScoreStale(
  status: LeadScoreStatus | null | undefined,
  computedAt: string | null | undefined,
  now: Date,
): boolean {
  if (status !== "ready") return true;
  if (typeof computedAt !== "string" || computedAt === "") return true;
  const at = Date.parse(computedAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at > LEAD_SCORE_STALE_AFTER_MS;
}

export type StoredLeadScoreRow = {
  value: number | null;
  band: string | null;
  signals: unknown;
  computedAt: string | null;
  status: string | null;
};

// F1-21: Validiert eine gespeicherte Score-Zeile fail-closed — alles
// Unbekannte (falsches Band, fremde Signale, Wert außerhalb 0..100,
// Band/Wert-Widerspruch) liefert null, der Aufrufer fällt synchron zurück.
export function leadScoreSnapshotFromStored(
  row: StoredLeadScoreRow,
  now: Date,
): LeadScoreSnapshot | null {
  if (
    typeof row.value !== "number"
    || !Number.isInteger(row.value)
    || row.value < 0
    || row.value > 100
  ) {
    return null;
  }
  if (row.band !== "hot" && row.band !== "warm" && row.band !== "cold") return null;
  if (scoreBandForValue(row.value) !== row.band) return null;
  if (!Array.isArray(row.signals) || !row.signals.every(isLeadScoreSignal)) return null;
  if (row.status !== "pending" && row.status !== "ready") return null;
  if (typeof row.computedAt !== "string" || row.computedAt === "") return null;
  const at = Date.parse(row.computedAt);
  if (Number.isNaN(at)) return null;
  return {
    value: row.value,
    band: row.band,
    signals: [...row.signals].sort(
      (left, right) => BAND_ORDER.indexOf(left) - BAND_ORDER.indexOf(right),
    ),
    stale: isLeadScoreStale(row.status, row.computedAt, now),
    computedAt: row.computedAt,
  };
}
