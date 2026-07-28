import { Schema } from "effect";

import { BoardName, MAX_BOARD_NAME } from "./board";

/**
 * Board **management** schema + link helpers (the `/boards` surface). The
 * singular `board.ts` owns the board's own domain — grid, message, pairing
 * inputs. This file is deliberately the thin form/URL layer on top of it and
 * re-uses `BoardName`/`MAX_BOARD_NAME` rather than restating the bounds.
 */

/**
 * The create-board form. The field is a plain bounded string, **not** `BoardName`
 * (which requires at least one character), because "leave it blank and let the
 * server name it" is a supported way to fill this form: `board.create` takes
 * `name` as optional and defaults it. Blank therefore has to validate, and
 * `normalizeBoardName` is what turns blank into "send no name at all".
 */
export const CreateBoardFormSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.maxLength(MAX_BOARD_NAME)),
});
export type CreateBoardFormInput = typeof CreateBoardFormSchema.Type;

const isBoardName = Schema.is(BoardName);

/**
 * Form field → the `name` argument for `board.create`.
 *
 * Trims, and collapses "empty" (missing, blank, whitespace-only) to `undefined`
 * so the caller can omit the key entirely and let the procedure's own default
 * apply. Returning `""` instead would fail `BoardName`'s `minLength(1)` and turn
 * an empty optional field into a validation error.
 */
export const normalizeBoardName = (
  raw: string | null | undefined
): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Is this a name `board.create` will accept? Checked at the form action so an
 * over-long name comes back as readable copy on the field instead of a raw
 * BAD_REQUEST from the procedure's input decode.
 */
export const isValidBoardName = (name: string): boolean => isBoardName(name);

/** `/b/<id>` — the URL that gets typed into a TV browser. */
export const boardDisplayPath = (boardId: string): string =>
  `/b/${encodeURIComponent(boardId)}`;

/** `/b/<id>/c` — the phone controller. */
export const boardControlPath = (boardId: string): string =>
  `${boardDisplayPath(boardId)}/c`;

/**
 * The absolute TV URL. `origin` comes from the request in the loader (not
 * `window.location`), so server and client render the identical string and the
 * copyable address is correct on localhost, preview and production alike.
 */
export const boardTvUrl = (origin: string, boardId: string): string =>
  `${origin.replace(/\/+$/, "")}${boardDisplayPath(boardId)}`;

/** Why a create attempt did not produce a board. Keys into `boards.create.error.*`. */
export type CreateBoardFailure = "name_too_long" | "create_failed";

/**
 * The rename-board dialog form. `BoardName` (not the create form's plain
 * bounded string) because a rename never has "leave it blank" as an option —
 * there is no server-side default to fall back to mid-edit.
 */
export const RenameBoardFormSchema = Schema.Struct({
  name: BoardName,
});
export type RenameBoardFormInput = typeof RenameBoardFormSchema.Type;

/** Why a rename attempt did not go through. Keys into `boards.rename.error.*`. */
export type RenameBoardFailure = "name_too_long" | "name_empty" | "rename_failed";

/** Why a delete attempt did not go through. Keys into `boards.delete.error.*`. */
export type DeleteBoardFailure = "delete_failed";

/**
 * Why a revoke attempt did not go through. Keys into `boards.revoke.error.*`.
 * One case, like delete: the procedure is owner-only and takes nothing but an id,
 * so there is no input the form could get wrong.
 */
export type RevokeControllersFailure = "revoke_failed";
