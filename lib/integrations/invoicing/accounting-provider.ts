// F8-21 Accounting-Provider: minimales Transport-Interface (DECIDED) +
// Fake-Transport für Tests. Kein SDK, kein OAuth, kein HTTP, keine Secrets:
// Auth eines echten Transports wird zur Laufzeit injiziert, nie persistiert.

import type {
  AccountingExportPayload,
  AccountingVendor,
} from "./accounting-contract";

export type AccountingExportResult = {
  externalId: string;
  rawStatus: string;
};

export interface AccountingProvider {
  readonly vendor: AccountingVendor;
  exportVoucher(payload: AccountingExportPayload): Promise<AccountingExportResult>;
}

export class AccountingProviderError extends Error {
  readonly vendor: AccountingVendor;
  constructor(vendor: AccountingVendor, detail: string) {
    super(`accounting-provider:${vendor}: ${detail}`);
    this.name = "AccountingProviderError";
    this.vendor = vendor;
  }
}

export type FakeAccountingSentVoucher = {
  sequence: number;
  payloadShaHint: string;
  externalId: string;
};

// Deterministischer In-Memory-Transport: fortlaufende external_ids,
// programmierbare Fehler für Run/Retry-Tests. Speichert nur Referenzen
// (Payload-Hash-Kurzform + external_id), nie Secrets.
export class FakeAccountingProvider implements AccountingProvider {
  readonly vendor: AccountingVendor;
  readonly sent: FakeAccountingSentVoucher[] = [];
  attempts = 0;

  private sequence = 0;
  private nextFailures: string[] = [];
  private persistentFailure: string | null = null;

  constructor(vendor: AccountingVendor) {
    this.vendor = vendor;
  }

  failNext(message: string): void {
    this.nextFailures.push(message);
  }

  failAlways(message: string): void {
    this.persistentFailure = message;
  }

  recover(): void {
    this.nextFailures = [];
    this.persistentFailure = null;
  }

  async exportVoucher(payload: AccountingExportPayload): Promise<AccountingExportResult> {
    this.attempts += 1;
    const failure = this.nextFailures.shift() ?? this.persistentFailure;
    if (failure !== null && failure !== undefined) {
      throw new AccountingProviderError(this.vendor, failure);
    }
    this.sequence += 1;
    const externalId = `fake-${this.vendor}-${String(this.sequence).padStart(6, "0")}`;
    this.sent.push({
      sequence: this.sequence,
      payloadShaHint: `${payload.kind}:${payload.number}`,
      externalId,
    });
    return { externalId, rawStatus: "accepted" };
  }
}
