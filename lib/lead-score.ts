// F1-07 Lead-Score (Regel-Score v1, ESTIMATE).
//
// Katalog: "AI Lead Score 0-100 (asynchron, Ampel, Filter-Presets, Signale)".
// v1 ist ein deterministischer Regel-Score über bereits vorhandene,
// revisionierte Daten (Kontakt/Site/Energieprofil/Bedarf/Zuweisung/Quelle) —
// kein ML-Modell, keine Hintergrund-Berechnung: Der Score wird beim Lesen
// des Boards aus denselben Zeilen abgeleitet, die die Karte ohnehin lädt
// (kein Worker, keine Score-at-rest-Spalte, keine Staleness-Falle).
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
};

export type LeadScore = {
  value: number;
  band: LeadScoreBand;
  signals: LeadScoreSignal[];
};

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
];

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
  };
  const signals = BAND_ORDER.filter((signal) => met[signal]);
  const value = signals.reduce((sum, signal) => sum + LEAD_SCORE_WEIGHTS[signal], 0);
  return { value, band: scoreBandForValue(value), signals };
}
