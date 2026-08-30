import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
  OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION,
} from "@/lib/integrations/offers/release-contract";
import {
  activateOfferReleaseProfile,
  readCurrentOfferReleaseProfile,
  reviseOfferReleaseProfile,
} from "@/modules/offers/release-profile-service";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

const PROFILE = {
  profileName: "Synthetisches DB-Leseprofil",
  sender: {
    legalName: "Testenergie GmbH",
    tradingName: "Testenergie",
    representedBy: "Mara Muster",
    address: {
      street: "Sonnenallee",
      houseNumber: "17",
      postalCode: "10115",
      city: "Berlin",
      country: "DE" as const,
    },
    email: "office@release.invalid",
    phoneE164: "+49301234567",
    websiteHttpsUrl: "https://release.invalid",
    registerCourt: "Amtsgericht Berlin",
    registerNumber: "HRB 12345",
    vatId: "DE123456789",
  },
  legalDocuments: {
    terms: { title: "Angebotsbedingungen", plainText: "Synthetische Bedingungen" },
    withdrawalInformation: {
      title: "Widerrufsinformation",
      plainText: "Synthetische Widerrufsinformation",
    },
    privacyNotice: {
      title: "Datenschutzhinweis",
      plainText: "Synthetischer Datenschutzhinweis",
    },
  },
};

describe("M2-03a Profil-Readback gegen Real-Postgres", () => {
  it("liest den frisch aktivierten Profilstand mit exakt derselben Bindung", async () => {
    const workspaceId = randomUUID();
    let actorId = "";
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into workspace (id, name)
        values (${workspaceId}::uuid, 'M2-03a Profil-Readback')
      `);
      const offerFixture = tenantFixtures.offer;
      if (!offerFixture) throw new Error("Offer-Tenant-Fixture fehlt");
      await offerFixture(tx, workspaceId);
      const actor = await tx.execute<{ created_by: string; [key: string]: unknown }>(sql`
        select created_by from offer
         where workspace_id = ${workspaceId}::uuid
         limit 1
      `);
      actorId = actor.rows[0]?.created_by ?? "";
      if (actorId === "") throw new Error("Offer-Actor fehlt");
      await tx.execute(sql`
        update membership set role = 'admin'
         where workspace_id = ${workspaceId}::uuid
           and user_id = ${actorId}::uuid
      `);
    });

    await withAuthorizedTenantOn(testPool, actorId, workspaceId, async (tx, ctx) => {
      const revised = await reviseOfferReleaseProfile(tx, ctx, {
        schemaVersion: OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION,
        workspaceId,
        expectedCurrentRevision: 0,
        ...PROFILE,
      });
      const activated = await activateOfferReleaseProfile(tx, ctx, {
        schemaVersion: OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
        workspaceId,
        profileId: revised.profileId,
        profileRevisionId: revised.profileRevisionId,
        expectedProfileRevision: revised.revision,
      });
      const readback = await readCurrentOfferReleaseProfile(tx, ctx, { workspaceId });

      expect(readback).toMatchObject({
        profileId: revised.profileId,
        currentRevision: revised.revision,
        current: revised.snapshot,
        active: {
          activationId: activated.activationId,
          profileRevisionId: revised.profileRevisionId,
          profileRevision: revised.revision,
          reviewState: "operator_reviewed",
          snapshot: revised.snapshot,
        },
      });
    });
  });
});
