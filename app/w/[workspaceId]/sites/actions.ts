"use server";

import { authorizedAction } from "@/lib/action";
import { createSite } from "@/modules/sites";
import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (value === null || (typeof value === "string" && value.trim() === "") ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalNumber = z.preprocess(
  (value) => (value === null || (typeof value === "string" && value.trim() === "") ? undefined : value),
  z.coerce.number().finite().optional(),
);

const createSiteForm = z.object({
  workspaceId: z.uuid(),
  label: optionalText,
  street: optionalText,
  houseNumber: optionalText,
  postalCode: optionalText,
  city: optionalText,
  country: optionalText,
  lat: optionalNumber,
  lng: optionalNumber,
});

export async function createSiteAction(workspaceId: string, formData: FormData): Promise<{ id: string }> {
  // Die Pfad-UUID wird vor authorizedAction validiert, damit kaputte Segmente
  // keine Tenant-Transaktion öffnen.
  const parsed = createSiteForm.parse({
    workspaceId,
    label: formData.get("label"),
    street: formData.get("street"),
    houseNumber: formData.get("houseNumber"),
    postalCode: formData.get("postalCode"),
    city: formData.get("city"),
    country: formData.get("country"),
    lat: formData.get("lat"),
    lng: formData.get("lng"),
  });
  const { workspaceId: validWorkspaceId, ...input } = parsed;

  return authorizedAction(validWorkspaceId, "project.write", "site", (tx, ctx) =>
    createSite(tx, ctx, input),
  );
}
