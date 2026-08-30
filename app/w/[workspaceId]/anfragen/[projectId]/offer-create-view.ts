export type OfferCreateBlockerView = {
  code: string;
  label: string;
  href: string;
  actionLabel: string;
};

export type OfferCreateRevisionInput = {
  expectedRequirementRevision: number;
  expectedCalculationRevision: number;
  expectedResolutionRevision: number;
};

export type OfferCreateEntryView =
  | {
      state: "ready";
      workspaceId: string;
      projectId: string;
      customerDisplayName: string;
      installationSiteLabel: string;
      input: OfferCreateRevisionInput;
    }
  | {
      state: "blocked";
      workspaceId: string;
      projectId: string;
      blockers: readonly OfferCreateBlockerView[];
    }
  | {
      state: "read_only";
      workspaceId: string;
      projectId: string;
    }
  | {
      state: "converted";
      workspaceId: string;
      projectId: string;
      offersHref: string;
    };

export type OfferCreateServerGate = {
  canCreate: boolean;
  configurationBlockers: readonly {
    code: string;
    label: string;
  }[];
  catalog: {
    state: "blocked" | "pending" | "current" | "stale";
    blocker:
      | "missing_requirement"
      | "missing_calculation"
      | "calculation_not_current"
      | "calculation_invalid"
      | null;
    expectedRequirementRevision: number | null;
    expectedCalculationRevision: number | null;
    expectedResolutionRevision: number | null;
  } | null;
};

type BuildOfferCreateViewInput = {
  workspaceId: string;
  projectId: string;
  detailPath: string;
  detail: {
    phase: string;
    outcome: string;
    sourceLabel: string;
    submittedAt: string | null;
    customerDisplayName: string;
    installationSiteLabel: string | null;
    blockers: {
      dedupeReviewRequired: boolean;
      addressFollowUpRequired: boolean;
      pinConfirmationRequired: boolean;
      catalogResolutionPending: boolean;
    };
  };
  gate: OfferCreateServerGate;
};

const catalogBlockerLabels: Record<
  NonNullable<NonNullable<OfferCreateServerGate["catalog"]>["blocker"]>,
  string
> = {
  missing_requirement: "Der aktuelle Bedarf fehlt oder ist nicht revisionsgebunden.",
  missing_calculation: "Für den aktuellen Bedarf fehlt eine Planungsrechnung.",
  calculation_not_current: "Die Planungsrechnung gehört nicht mehr zum aktuellen Projektstand.",
  calculation_invalid: "Die Planungsrechnung ist nicht konsistent genug für ein Angebot.",
};

function isPositiveRevision(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 1;
}

function pushUnique(
  blockers: OfferCreateBlockerView[],
  blocker: OfferCreateBlockerView,
): void {
  if (!blockers.some((candidate) => candidate.code === blocker.code)) {
    blockers.push(blocker);
  }
}

export function buildOfferCreateView(
  input: BuildOfferCreateViewInput,
): OfferCreateEntryView {
  const { workspaceId, projectId, detailPath, detail, gate } = input;
  const productsPath = `${detailPath}/produkte`;
  const energyPath = `${detailPath}/energieprofil`;
  const requestsPath = `/w/${workspaceId}/anfragen`;
  const offersPath = `/w/${workspaceId}/angebote`;

  if (detail.phase === "offer") {
    return {
      state: "converted",
      workspaceId,
      projectId,
      offersHref: offersPath,
    };
  }
  if (!gate.canCreate) {
    return { state: "read_only", workspaceId, projectId };
  }

  const blockers: OfferCreateBlockerView[] = [];
  if (detail.phase !== "request") {
    pushUnique(blockers, {
      code: "project_phase",
      label: "Nur eine offene Anfrage kann in einen Angebotsentwurf überführt werden.",
      href: requestsPath,
      actionLabel: "Anfragen prüfen",
    });
  }
  if (detail.outcome !== "open") {
    pushUnique(blockers, {
      code: "project_outcome",
      label: "Das Projekt ist nicht mehr offen.",
      href: requestsPath,
      actionLabel: "Zum Anfrage-Board",
    });
  }
  if (detail.sourceLabel !== "Solarrechner" || detail.submittedAt === null) {
    pushUnique(blockers, {
      code: "request_binding",
      label: "Es fehlt eine gebundene Wohngebäude-Anfrage aus dem Solarrechner.",
      href: requestsPath,
      actionLabel: "Anfragequelle prüfen",
    });
  }
  if (detail.blockers.dedupeReviewRequired) {
    pushUnique(blockers, {
      code: "dedupe_review",
      label: "Die mögliche Dublette muss vor der Konvertierung geprüft werden.",
      href: requestsPath,
      actionLabel: "Dublette im Board prüfen",
    });
  }
  if (detail.blockers.addressFollowUpRequired) {
    pushUnique(blockers, {
      code: "address_follow_up",
      label: "Die Installationsadresse muss zuerst hausgenau nachbearbeitet werden.",
      href: `${detailPath}#standort-und-pin`,
      actionLabel: "Adresse nachbearbeiten",
    });
  }
  if (detail.blockers.pinConfirmationRequired) {
    pushUnique(blockers, {
      code: "pin_confirmation",
      label: "Der Planungs-Pin muss für die aktuelle Adresse bestätigt werden.",
      href: `${detailPath}#standort-und-pin`,
      actionLabel: "Planungs-Pin prüfen",
    });
  }

  for (const blocker of gate.configurationBlockers) {
    pushUnique(blockers, {
      code: blocker.code,
      label: blocker.label,
      href: offersPath,
      actionLabel: "Angebotskonfiguration prüfen",
    });
  }

  const catalog = gate.catalog;
  if (catalog === null) {
    pushUnique(blockers, {
      code: "catalog_unavailable",
      label: "Der revisionsgebundene Produktstand ist nicht verfügbar.",
      href: productsPath,
      actionLabel: "Produktstand prüfen",
    });
  } else {
    if (catalog.blocker !== null) {
      const calculationBlocker = catalog.blocker !== "missing_requirement";
      pushUnique(blockers, {
        code: catalog.blocker,
        label: catalogBlockerLabels[catalog.blocker],
        href: calculationBlocker ? energyPath : `${detailPath}#bedarf`,
        actionLabel: calculationBlocker
          ? "Planungsrechnung prüfen"
          : "Bedarf prüfen",
      });
    }
    if (catalog.blocker === null && catalog.state === "pending") {
      pushUnique(blockers, {
        code: "catalog_pending",
        label: "Die Produkte sind noch nicht revisionssicher zugeordnet.",
        href: productsPath,
        actionLabel: "Produkte zuordnen",
      });
    }
    if (catalog.state === "stale") {
      pushUnique(blockers, {
        code: "catalog_stale",
        label: "Die Produktauflösung ist nicht mehr aktuell.",
        href: productsPath,
        actionLabel: "Produktauflösung aktualisieren",
      });
    }
    if (catalog.state === "blocked" && catalog.blocker === null) {
      pushUnique(blockers, {
        code: "catalog_blocked",
        label: "Die Produktauflösung ist für den aktuellen Projektstand blockiert.",
        href: productsPath,
        actionLabel: "Produktblocker prüfen",
      });
    }
  }

  if (
    detail.blockers.catalogResolutionPending
    && catalog?.state === "current"
  ) {
    pushUnique(blockers, {
      code: "catalog_project_status",
      label: "Der Projektstatus weist die Produktauflösung noch nicht als aktuell aus.",
      href: productsPath,
      actionLabel: "Produktauflösung prüfen",
    });
  }

  const revisions = catalog === null ? null : {
    expectedRequirementRevision: catalog.expectedRequirementRevision,
    expectedCalculationRevision: catalog.expectedCalculationRevision,
    expectedResolutionRevision: catalog.expectedResolutionRevision,
  };
  if (
    catalog?.state === "current"
    && (
      revisions === null
      || !isPositiveRevision(revisions.expectedRequirementRevision)
      || !isPositiveRevision(revisions.expectedCalculationRevision)
      || !isPositiveRevision(revisions.expectedResolutionRevision)
    )
  ) {
    pushUnique(blockers, {
      code: "revision_binding",
      label: "Der aktuelle Planungs- und Produktstand ist nicht vollständig revisionsgebunden.",
      href: productsPath,
      actionLabel: "Revisionsbindung prüfen",
    });
  }

  if (blockers.length > 0 || catalog?.state !== "current" || revisions === null) {
    return { state: "blocked", workspaceId, projectId, blockers };
  }

  if (
    !isPositiveRevision(revisions.expectedRequirementRevision)
    || !isPositiveRevision(revisions.expectedCalculationRevision)
    || !isPositiveRevision(revisions.expectedResolutionRevision)
  ) {
    return {
      state: "blocked",
      workspaceId,
      projectId,
      blockers: [{
        code: "revision_binding",
        label: "Der aktuelle Planungs- und Produktstand ist nicht vollständig revisionsgebunden.",
        href: productsPath,
        actionLabel: "Revisionsbindung prüfen",
      }],
    };
  }

  const expectedRequirementRevision = revisions.expectedRequirementRevision;
  const expectedCalculationRevision = revisions.expectedCalculationRevision;
  const expectedResolutionRevision = revisions.expectedResolutionRevision;

  return {
    state: "ready",
    workspaceId,
    projectId,
    customerDisplayName: detail.customerDisplayName,
    installationSiteLabel: detail.installationSiteLabel ?? "Standort nicht verfügbar",
    input: {
      expectedRequirementRevision,
      expectedCalculationRevision,
      expectedResolutionRevision,
    },
  };
}

const MAX_FORECAST_CENTS = BigInt("9000000000000000");

/** Human-readable EUR input to the integer-cent field accepted by the Action. */
export function euroForecastToCents(rawValue: string): string | null {
  const value = rawValue.trim().replace(/[\s\u00a0\u202f]/gu, "");
  if (value === "") return "";
  if (!/^[0-9.,]+$/u.test(value)) return null;

  let euros: string;
  let fraction = "";
  if (value.includes(",") && value.includes(".")) {
    if (/^\d{1,3}(?:\.\d{3})*,\d{1,2}$/u.test(value)) {
      const [whole, decimals] = value.split(",");
      euros = whole.replaceAll(".", "");
      fraction = decimals;
    } else if (/^\d{1,3}(?:,\d{3})*\.\d{1,2}$/u.test(value)) {
      const lastDot = value.lastIndexOf(".");
      euros = value.slice(0, lastDot).replaceAll(",", "");
      fraction = value.slice(lastDot + 1);
    } else {
      return null;
    }
  } else if (value.includes(",")) {
    if (!/^\d+,\d{1,2}$/u.test(value)) return null;
    [euros, fraction] = value.split(",");
  } else if (value.includes(".")) {
    if (/^\d+\.\d{1,2}$/u.test(value)) {
      [euros, fraction] = value.split(".");
    } else if (/^\d{1,3}(?:\.\d{3})+$/u.test(value)) {
      euros = value.replaceAll(".", "");
    } else {
      return null;
    }
  } else {
    euros = value;
  }

  if (!/^\d+$/u.test(euros) || (fraction !== "" && !/^\d{1,2}$/u.test(fraction))) {
    return null;
  }
  const cents = BigInt(euros) * BigInt(100)
    + BigInt(fraction.padEnd(2, "0") || "0");
  return cents <= MAX_FORECAST_CENTS ? cents.toString() : null;
}
