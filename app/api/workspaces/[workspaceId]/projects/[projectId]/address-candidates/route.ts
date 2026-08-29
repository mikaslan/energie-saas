import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  FixedWindowRateLimiter,
  handleAddressCandidateSearchRequest,
  searchAddressCandidates,
  type AddressCandidateSearchAccess,
} from "@/lib/integrations/geocoding";
import { PermissionDeniedError } from "@/lib/permissions";
import { getProjectAddressCorrectionContext } from "@/modules/projects";

const rateLimiter = new FixedWindowRateLimiter(20, 60_000);

async function authorizeAddressSearch(input: {
  workspaceId: string;
  projectId: string;
}): Promise<AddressCandidateSearchAccess> {
  try {
    const result = await authorizedQuery(
      input.workspaceId,
      "project.write",
      "site_address_search",
      async (tx, ctx) => {
        const context = await getProjectAddressCorrectionContext(tx, ctx, input.projectId);
        if (context === null) return null;
        return { context, actorId: ctx.actor };
      },
    );

    if (result === null) return { status: "not_found" };
    if (!result.context.editable) return { status: "not_editable" };
    return {
      status: "allowed",
      rateLimitKey: JSON.stringify([input.workspaceId, result.actorId]),
    };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "forbidden" };
    throw error;
  }
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{ workspaceId: string; projectId: string }>;
  },
): Promise<Response> {
  const params = await context.params;
  return handleAddressCandidateSearchRequest(request, params, {
    authorize: authorizeAddressSearch,
    search: searchAddressCandidates,
    rateLimiter,
  });
}
