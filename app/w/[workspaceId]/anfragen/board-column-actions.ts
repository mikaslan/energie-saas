"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  archiveBoardColumn,
  BoardColumnConflictError,
  BoardColumnValidationError,
  createBoardColumn,
  moveBoardColumn,
  renameBoardColumn,
  restoreBoardColumn,
} from "@/modules/boards";

const uuidSchema = z.uuid();

export type BoardColumnAction =
  | "created"
  | "renamed"
  | "moved"
  | "archived"
  | "restored";

export type BoardColumnActionState =
  | { status: "idle" }
  | { status: "success"; action: BoardColumnAction; detail?: string }
  | { status: "invalid"; detail?: string }
  | { status: "conflict"; detail?: string }
  | { status: "unauthenticated" }
  | { status: "denied" };

function conflictDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("intake")) return "intake";
  if (message.includes("still holds cards")) return "non_empty";
  if (message.includes("not found")) return "not_found";
  if (message.includes("archived")) return "archived";
  return "other";
}

function mapColumnError(error: unknown): BoardColumnActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof BoardColumnValidationError) {
    return {
      status: "invalid",
      detail: error.message.includes("intake") ? "intake" : undefined,
    };
  }
  if (error instanceof BoardColumnConflictError) {
    return { status: "conflict", detail: conflictDetail(error) };
  }
  throw error;
}

function revalidateBoard(workspaceId: string): void {
  revalidatePath(`/w/${workspaceId}/anfragen`);
}

export async function createBoardColumnAction(
  workspaceId: string,
  boardId: string,
  _previousState: BoardColumnActionState,
  formData: FormData,
): Promise<BoardColumnActionState> {
  const name = formData.get("name");
  const columnType = formData.get("columnType");
  const color = formData.get("color");
  if (!z.uuid().safeParse(workspaceId).success || !z.uuid().safeParse(boardId).success) {
    return { status: "invalid" };
  }
  try {
    const created = await authorizedAction(
      workspaceId,
      "project.write",
      "kanban_column",
      (tx, ctx) => createBoardColumn(tx, ctx, {
        boardId,
        name: typeof name === "string" ? name : "",
        columnType: typeof columnType === "string" ? columnType : "",
        color: typeof color === "string" && color !== "" ? color : undefined,
      }),
    );
    revalidateBoard(workspaceId);
    return { status: "success", action: "created", detail: created.id };
  } catch (error) {
    return mapColumnError(error);
  }
}

export async function renameBoardColumnAction(
  workspaceId: string,
  _previousState: BoardColumnActionState,
  formData: FormData,
): Promise<BoardColumnActionState> {
  const columnId = uuidSchema.safeParse(formData.get("columnId"));
  const name = formData.get("name");
  if (!z.uuid().safeParse(workspaceId).success || !columnId.success) {
    return { status: "invalid" };
  }
  try {
    const renamed = await authorizedAction(
      workspaceId,
      "project.write",
      "kanban_column",
      (tx, ctx) => renameBoardColumn(tx, ctx, {
        columnId: columnId.data,
        name: typeof name === "string" ? name : "",
      }),
    );
    revalidateBoard(workspaceId);
    return { status: "success", action: "renamed", detail: renamed.name };
  } catch (error) {
    return mapColumnError(error);
  }
}

export async function moveBoardColumnAction(
  workspaceId: string,
  _previousState: BoardColumnActionState,
  formData: FormData,
): Promise<BoardColumnActionState> {
  const columnId = uuidSchema.safeParse(formData.get("columnId"));
  const direction = formData.get("direction");
  if (
    !z.uuid().safeParse(workspaceId).success || !columnId.success
    || (direction !== "left" && direction !== "right")
  ) {
    return { status: "invalid" };
  }
  try {
    const moved = await authorizedAction(
      workspaceId,
      "project.write",
      "kanban_column",
      (tx, ctx) => moveBoardColumn(tx, ctx, { columnId: columnId.data, direction }),
    );
    revalidateBoard(workspaceId);
    return { status: "success", action: "moved", detail: moved.changed ? undefined : "edge" };
  } catch (error) {
    return mapColumnError(error);
  }
}

export async function archiveBoardColumnAction(
  workspaceId: string,
  _previousState: BoardColumnActionState,
  formData: FormData,
): Promise<BoardColumnActionState> {
  const columnId = uuidSchema.safeParse(formData.get("columnId"));
  if (!z.uuid().safeParse(workspaceId).success || !columnId.success) {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(
      workspaceId,
      "project.write",
      "kanban_column",
      (tx, ctx) => archiveBoardColumn(tx, ctx, { columnId: columnId.data }),
    );
    revalidateBoard(workspaceId);
    return { status: "success", action: "archived" };
  } catch (error) {
    return mapColumnError(error);
  }
}

export async function restoreBoardColumnAction(
  workspaceId: string,
  _previousState: BoardColumnActionState,
  formData: FormData,
): Promise<BoardColumnActionState> {
  const columnId = uuidSchema.safeParse(formData.get("columnId"));
  if (!z.uuid().safeParse(workspaceId).success || !columnId.success) {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(
      workspaceId,
      "project.write",
      "kanban_column",
      (tx, ctx) => restoreBoardColumn(tx, ctx, { columnId: columnId.data }),
    );
    revalidateBoard(workspaceId);
    return { status: "success", action: "restored" };
  } catch (error) {
    return mapColumnError(error);
  }
}
