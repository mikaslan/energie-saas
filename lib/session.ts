import { headers } from "next/headers";
import { getAuth } from "./auth";

export type SessionUser = { authUserId: string };

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const authUserId = session?.user?.id;
  return authUserId ? { authUserId } : null;
}
