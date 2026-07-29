import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { IconDeviceMobile, IconExternalLink } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StackBadge } from "@/components/stack-badge";
import { BoardTvUrl } from "@/components/boards/board-tv-url";
import { BoardDeleteDialog } from "@/components/boards/board-delete-dialog";
import { BoardRenameDialog } from "@/components/boards/board-rename-dialog";
import { BoardRevokeDialog } from "@/components/boards/board-revoke-dialog";
import {
  BoardDevices,
  type PairedDevice,
} from "@/components/boards/board-devices";
import { formatDate } from "@/lib/date-utils";
import { boardControlPath, boardDisplayPath, boardTvUrl } from "@/lib/schemas/boards";
import { cn } from "@/lib/utils";

interface BoardCardProps {
  readonly board: {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
    readonly createdAt: string | number | Date;
    /** Phones paired to this board, newest-seen first. Read in the loader. */
    readonly devices: ReadonlyArray<PairedDevice>;
  };
  /** Absolute origin of the current request — the TV URL is built from it. */
  readonly origin: string;
  /** True for the board that was just created, so the eye lands on it. */
  readonly isNew?: boolean;
}

/**
 * One board, expressed as the three things an owner does with it: read its
 * address onto a TV, open that display, and drive it from a phone.
 *
 * `revision` is surfaced as plain language rather than a number-only badge —
 * `0` means "nothing has ever been written to this board", which is the one fact
 * that tells a new owner whether their board is live or just allocated.
 */
export function BoardCard({ board, origin, isNew = false }: BoardCardProps) {
  const { t, i18n } = useTranslation("boards");
  const tvUrl = boardTvUrl(origin, board.id);

  return (
    <Card
      data-testid="board-card"
      data-board-id={board.id}
      className={cn(
        "transition-shadow hover:shadow-md",
        isNew && "border-primary/60 shadow-md"
      )}
    >
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h3
              data-testid="board-card-name"
              className="truncate text-base font-semibold tracking-tight"
            >
              {board.name}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("card.created", {
                date: formatDate(new Date(board.createdAt), "PP", i18n.language),
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {isNew && <StackBadge active>{t("card.new")}</StackBadge>}
            <StackBadge active={board.revision > 0}>
              {board.revision > 0
                ? t("card.revision", { revision: board.revision })
                : t("card.never_written")}
            </StackBadge>
          </div>
        </div>

        <BoardTvUrl url={tvUrl} />

        <div className="flex flex-col gap-2 sm:flex-row">
          {/*
            A new tab, not a client-side navigation: the TV display is a kiosk
            surface (no chrome, no way back) and the laptop that is setting the
            board up wants to keep this list open.
          */}
          <Button asChild variant="secondary" size="sm" className="sm:flex-1">
            <a
              href={boardDisplayPath(board.id)}
              target="_blank"
              rel="noreferrer"
              data-testid="board-card-open"
            >
              <IconExternalLink className="size-4" />
              {t("card.open")}
            </a>
          </Button>
          {/*
            The owner needs no pairing token — `requireBoardAccess` accepts an
            owning session directly — so this is a plain in-app link.
          */}
          <Button asChild variant="outline" size="sm" className="sm:flex-1">
            <Link to={boardControlPath(board.id)} data-testid="board-card-control">
              <IconDeviceMobile className="size-4" />
              {t("card.control")}
            </Link>
          </Button>
        </div>

        {/*
          The owner-only row. Revoke sits next to rename and delete rather than
          beside "Control from phone", because it is a thing you do *to* the
          board's paired phones, not a way of driving the board — and because the
          three of them are the operations only an owning session can perform.
        */}
        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row">
          <BoardRenameDialog boardId={board.id} currentName={board.name} />
          <BoardRevokeDialog boardId={board.id} boardName={board.name} />
          <BoardDeleteDialog boardId={board.id} boardName={board.name} />
        </div>

        {/*
          Below the owner row, not inside it. The controls above act on the board
          as a whole; this names individual devices, and mixing "un-pair Kai's
          phone" into a row that also contains "delete this board" is how someone
          presses the wrong one.
        */}
        <BoardDevices
          boardId={board.id}
          boardName={board.name}
          devices={board.devices}
        />
      </CardContent>
    </Card>
  );
}
