export class FunnelCampaignNotFoundError extends Error {
  constructor(public readonly funnelCampaignId: string) {
    super(`funnel_campaign not found: ${funnelCampaignId}`);
    this.name = "FunnelCampaignNotFoundError";
  }
}

export class FunnelCampaignConflictError extends Error {
  constructor(public readonly name: string) {
    super(`funnel_campaign name/slug conflict: ${name}`);
    this.name = "FunnelCampaignConflictError";
  }
}

export class FunnelCampaignValidationError extends Error {
  constructor(message = "funnel_campaign validation failed") {
    super(message);
    this.name = "FunnelCampaignValidationError";
  }
}
