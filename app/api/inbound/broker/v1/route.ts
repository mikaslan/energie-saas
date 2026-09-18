import { verifiedBrokerIntakeAction } from "@/lib/action";
import { handleBrokerIntakeRequest } from "@/lib/integrations/broker/http";
import { processBrokerIntake } from "@/modules/intake";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleBrokerIntakeRequest(request, (identity, payload, meta) =>
    verifiedBrokerIntakeAction(identity, (tx, ctx) =>
      processBrokerIntake(tx, ctx, payload, meta)));
}
