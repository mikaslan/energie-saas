import { describe, expect, it } from "vitest";
import {
  PROJECT_OUTCOME_COMMAND_VERSION,
  PROJECT_OUTCOME_MAX_REVISION,
  projectClosedRequestFilterSchema,
  projectOutcomeCommandV1Schema,
} from "@/modules/projects";
import {
  CUSTOMER_NOTIFICATION_DISPATCH_VERSION,
  CUSTOMER_NOTIFICATION_QUEUE,
  CUSTOMER_NOTIFICATION_TEMPLATE_ID,
  customerNotificationDispatchV1Schema,
  customerNotificationErrorClassSchema,
  customerNotificationStatusSchema,
} from "@/lib/integrations/notifications/contract";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const NOTIFICATION_ID = "20000000-0000-4000-8000-000000000002";

describe("M1-11b Cannot-Fulfil-Vertrag", () => {
  it("akzeptiert mark_cannot_fulfill additiv und kanonisiert IDs", () => {
    expect(projectOutcomeCommandV1Schema.parse({
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_cannot_fulfill",
      projectId: PROJECT_ID.toUpperCase(),
      expectedOutcomeRevision: 0,
      confirmation: "mark_cannot_fulfill",
    })).toEqual({
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_cannot_fulfill",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: 0,
      confirmation: "mark_cannot_fulfill",
    });
    // Die v1-Bestandskommandos bleiben gueltig.
    expect(projectOutcomeCommandV1Schema.safeParse({
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "reopen",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: 7,
      confirmation: "reopen",
    }).success).toBe(true);
    expect(projectOutcomeCommandV1Schema.safeParse({
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_won",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: PROJECT_OUTCOME_MAX_REVISION - 1,
      confirmation: "mark_won",
    }).success).toBe(true);
  });

  it("lehnt Fremdfelder und falsche Bestaetigungen fuer mark_cannot_fulfill ab", () => {
    const valid = {
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_cannot_fulfill",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: 0,
      confirmation: "mark_cannot_fulfill",
    } as const;
    for (const candidate of [
      { ...valid, confirmation: "yes" },
      { ...valid, lossReasonId: NOTIFICATION_ID },
      { ...valid, schemaVersion: "project-outcome-command.v2" },
    ]) {
      expect(projectOutcomeCommandV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("erweitert den Abschlussfilter um cannot_fulfill", () => {
    for (const filter of ["all", "won", "lost", "cannot_fulfill"]) {
      expect(projectClosedRequestFilterSchema.parse(filter)).toBe(filter);
    }
    expect(projectClosedRequestFilterSchema.safeParse("open").success).toBe(false);
  });

  it("pinnt Dispatch-Payload, Queue, Vorlage und Status/Fehlerklassen", () => {
    expect(CUSTOMER_NOTIFICATION_QUEUE).toBe("notification.customer");
    expect(CUSTOMER_NOTIFICATION_TEMPLATE_ID).toBe("cannot-fulfil.v1");
    expect(customerNotificationDispatchV1Schema.parse({
      schemaVersion: CUSTOMER_NOTIFICATION_DISPATCH_VERSION,
      workspaceId: PROJECT_ID,
      notificationId: NOTIFICATION_ID,
      attemptNumber: 1,
    })).toEqual({
      schemaVersion: CUSTOMER_NOTIFICATION_DISPATCH_VERSION,
      workspaceId: PROJECT_ID,
      notificationId: NOTIFICATION_ID,
      attemptNumber: 1,
    });
    expect(customerNotificationDispatchV1Schema.safeParse({
      schemaVersion: CUSTOMER_NOTIFICATION_DISPATCH_VERSION,
      workspaceId: PROJECT_ID,
      notificationId: NOTIFICATION_ID,
      attemptNumber: 0,
    }).success).toBe(false);
    expect(customerNotificationStatusSchema.options).toEqual([
      "queued",
      "delivered",
      "failed_retriable",
      "failed_final",
      "cancelled_contact_erased",
      "cancelled_manual",
    ]);
    expect(customerNotificationErrorClassSchema.safeParse("transport_unavailable").success)
      .toBe(true);
    expect(customerNotificationErrorClassSchema.safeParse("smtp 550 recipient rejected").success)
      .toBe(false);
  });
});
