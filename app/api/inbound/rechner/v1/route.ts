import { verifiedRechnerIntakeAction } from "@/lib/action";
import { handleRechnerIntakeRequest } from "@/lib/integrations/rechner/http";
import { processRechnerIntake } from "@/modules/intake";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleRechnerIntakeRequest(request, (identity, payload, meta) =>
    verifiedRechnerIntakeAction(identity, (tx, ctx) =>
      processRechnerIntake(tx, ctx, payload, meta)));
}
