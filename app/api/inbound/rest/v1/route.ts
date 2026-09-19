import { verifiedRestIntakeAction } from "@/lib/action";
import { handleRestIntakeRequest } from "@/lib/integrations/rest/http";
import { processRestIntake } from "@/modules/intake";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleRestIntakeRequest(request, (identity, payload, meta) =>
    verifiedRestIntakeAction(identity, (tx, ctx) =>
      processRestIntake(tx, ctx, payload, meta)));
}
