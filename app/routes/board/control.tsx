import { useCallback, useState } from "react";
import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { data, redirect } from "react-router";
import { IconRefresh } from "@tabler/icons-react";

import type { Route } from "./+types/control";
import { api } from "@/trpc/client";
import { cn } from "@/lib/utils";
import { useBoardSocket } from "@/hooks/use-board-socket";
import { clearGrantCookie, serializeGrantCookie } from "@/lib/board/pairing";
import { MessageEditor } from "@/components/board/message-editor";
import { PushToTalkButton } from "@/components/board/push-to-talk-button";
import { SoundPackPicker } from "@/components/board/sound-pack-picker";
import { HistoryStrip } from "@/components/board/history-strip";
import {
  CONSOLE,
  ConsoleReadout,
  PLATE_LIP,
} from "@/components/board/console";
import type { BoardMessage } from "@/lib/schemas/board";

/**
 * `/b/:boardId/c` — the phone. Thumb-sized targets, one column, portrait, and no
 * affordance that needs a hover.
 *
 * The authorisation story lives entirely in the loader. A phone arrives here by
 * scanning the TV's QR, which carries `?t=<pairing token>`; the loader redeems it
 * server-side, swaps it for an `HttpOnly` grant cookie, and **redirects to the
 * clean URL**. That redirect is not cosmetic: a pairing token left in the address
 * bar ends up in history, in a screenshot, in a shared link and in the `Referer`
 * of every outbound request from this page.
 */

export const handle = { i18n: ["board"] };

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const boardId = params.boardId;
  const url = new URL(request.url);
  // Off in local http dev, or the browser silently drops the cookie.
  const secure = url.protocol === "https:";
  const cleanUrl = `/b/${encodeURIComponent(boardId)}/c`;
  const token = url.searchParams.get("t");

  if (token !== null && token !== "") {
    const paired = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () => context.trpc.board.pair({ boardId, token }),
        catch: (cause) => cause,
      })
    );

    // Redirect on failure too. The token is spent, expired or forged either way —
    // there is nothing left to retry with, and it still must not linger in the
    // URL. The clean URL then finds no grant and renders the rescan prompt.
    if (Exit.isFailure(paired)) throw redirect(cleanUrl);

    throw redirect(cleanUrl, {
      headers: {
        "Set-Cookie": serializeGrantCookie({
          boardId,
          token: paired.value.grant,
          maxAgeSeconds: paired.value.grantMaxAgeSeconds,
          secure,
        }),
      },
    });
  }

  // No token: either we already hold a grant (the usual case, one redirect ago)
  // or this is the owner's own signed-in browser. `claim` answers both and never
  // throws on a refusal, so "not paired" is a state to render, not a crash.
  const claimed = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.claim({ boardId }),
      catch: (cause) => cause,
    })
  );

  const unpaired = {
    boardId,
    access: "none" as const,
    board: null,
    state: null,
  };

  /*
    A *thrown* `claim` is not an authorisation verdict.

    `claim` answers `ok: false` for every refusal it can judge, and never throws
    for one. So reaching here means something else broke — `room.getState`
    raising `ExternalServiceError` because the Durable Object was momentarily
    unreachable is the realistic case. Clearing the cookie on that path (which is
    what this used to do) destroyed a perfectly valid grant over one hiccup during
    a reload, and re-pairing needs physical access to the TV. Render the rescan
    prompt, keep the cookie, and the next reload works.
  */
  if (Exit.isFailure(claimed)) return data(unpaired);

  if (!claimed.value.ok) {
    return data(
      unpaired,
      // A judged refusal: the grant genuinely does not verify (expired, revoked,
      // forged). Bin it so the next scan starts clean instead of racing a stale
      // cookie.
      { headers: { "Set-Cookie": clearGrantCookie(boardId, secure) } }
    );
  }

  return data({
    boardId,
    access: claimed.value.access,
    board: claimed.value.board,
    state: claimed.value.state,
  });
}

type ControlStatus = "idle" | "sent" | "trimmed" | "failed" | "rescan";

export default function BoardControl({ loaderData }: Route.ComponentProps) {
  const { boardId, board, state } = loaderData;

  if (loaderData.access === "none" || board === null || state === null) {
    return <RescanPrompt />;
  }

  return (
    <Controller
      boardId={boardId}
      owner={loaderData.access === "owner"}
      board={board}
      state={state}
    />
  );
}

/**
 * The dark field the whole controller sits on.
 *
 * `min-h-dvh` on the content is not enough on its own: `body` is white, so an
 * iOS rubber-band scroll past either end flashes the page background straight
 * into the eyes of someone standing in a dim room. A fixed backdrop pinned to the
 * viewport is what actually covers that.
 *
 * `className="dark"` is load-bearing too. The app's dark variant is
 * `&:is(.dark *)`, so this makes every shadcn primitive *inside* the controller
 * resolve its dark tokens — the Switch, the Spinner, `FormMessage`'s destructive
 * red — without touching `<html>`, which the TV route and the dashboard share.
 */
function ConsoleField({
  children,
  ...rest
}: React.ComponentProps<"main">) {
  return (
    <>
      <div
        aria-hidden
        className="fixed inset-0 -z-10"
        style={{ backgroundColor: CONSOLE.field }}
      />
      <main
        className="dark mx-auto flex min-h-dvh max-w-md flex-col px-4 py-5"
        style={{ backgroundColor: CONSOLE.field, color: CONSOLE.ink }}
        {...rest}
      >
        {children}
      </main>
    </>
  );
}

/**
 * Not an error page. A phone that walked in with no grant (link shared, cookie
 * cleared, grant expired) has one useful action available, and it is not "retry".
 *
 * Dressed as the plate on the back of the unit that tells you what to do when it
 * is not working: engraved title, one instruction, one key.
 */
function RescanPrompt() {
  const { t } = useTranslation("board");
  return (
    <ConsoleField
      className="dark mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-6 py-5 text-center"
      data-testid="control-root"
      data-access="none"
    >
      <div className="flex flex-col gap-3" data-testid="control-rescan">
        <h1
          className="text-base font-medium uppercase"
          style={{ color: CONSOLE.ink, letterSpacing: "0.2em" }}
        >
          {t("control.rescan.title")}
        </h1>
        <p
          className="text-[13px] leading-relaxed"
          style={{ color: CONSOLE.inkDim }}
        >
          {t("control.rescan.body")}
        </p>
      </div>
      <button
        type="button"
        className="flex h-12 items-center justify-center gap-2 rounded-none px-6 text-[11px] font-medium uppercase"
        style={{
          color: CONSOLE.inkDim,
          letterSpacing: "0.16em",
          boxShadow: `inset 0 0 0 1px ${CONSOLE.hairline}`,
        }}
        onClick={() => window.location.reload()}
        data-testid="control-rescan-retry"
      >
        <IconRefresh className="size-4" aria-hidden />
        {t("control.rescan.retry")}
      </button>
    </ConsoleField>
  );
}

interface ControllerProps {
  readonly boardId: string;
  readonly owner: boolean;
  readonly board: {
    readonly name: string;
    readonly soundPack: string;
    readonly muted: boolean;
    readonly revision: number;
  };
  readonly state: { readonly revision: number };
}

function Controller({ boardId, owner, board, state }: ControllerProps) {
  const { t } = useTranslation("board");
  const utils = api.useUtils();

  /**
   * The live board. `/api/board-ws` accepts an owner session **or** a controller
   * grant for this exact board, so a grant-only phone opens the same socket the TV
   * does — no owner-only special case, and the revision the phone shows is the
   * revision the board is actually on.
   */
  const live = useBoardSocket({ boardId, initialState: state });

  // `baseRevision` is advisory (the room is last-write-wins), so the best number
  // available is enough: whatever the socket last saw, or whatever our own last
  // write returned.
  const [writtenRevision, setWrittenRevision] = useState(state.revision);
  const baseRevision = Math.max(writtenRevision, live.revision);

  /**
   * Settings the picker renders. `updateSettings` now writes D1 *and* pushes the
   * result into the room, so the socket does carry them — but this stays local
   * state seeded from the loader and advanced by the mutation's own response.
   *
   * Reading them straight off the socket would make the toggles unresponsive
   * exactly when the socket is reconnecting: the row would be updated, the TV would
   * follow, and the control that caused it would still be showing the old value.
   */
  const [settings, setSettings] = useState({
    soundPack: board.soundPack,
    muted: board.muted,
  });
  const [status, setStatus] = useState<ControlStatus>("idle");

  const onWriteError = useCallback((code: string | undefined) => {
    // UNAUTHORIZED is the grant having lapsed; everything else is a real failure.
    setStatus(code === "UNAUTHORIZED" ? "rescan" : "failed");
  }, []);

  const setMessage = api.board.setMessage.useMutation({
    onSuccess: (result) => {
      setWrittenRevision(result.revision);
      setStatus(result.truncated ? "trimmed" : "sent");
      void utils.board.history.invalidate();
    },
    onError: (error) => onWriteError(error.data?.code),
  });

  const updateSettings = api.board.updateSettings.useMutation({
    onSuccess: (updated) => {
      setSettings({ soundPack: updated.soundPack, muted: updated.muted });
      setStatus("sent");
    },
    onError: (error) => onWriteError(error.data?.code),
  });

  const history = api.board.history.useQuery({ boardId, limit: 12 });

  const send = useCallback(
    (message: BoardMessage) => {
      setStatus("idle");
      setMessage.mutate({ boardId, baseRevision, message, source: "manual" });
    },
    // `setMessage.mutate` is stable; `baseRevision` is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, baseRevision]
  );

  const changeSettings = useCallback(
    (next: { soundPack?: string; muted?: boolean }) => {
      setStatus("idle");
      updateSettings.mutate({ boardId, ...next });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId]
  );

  const pending = setMessage.isPending || updateSettings.isPending;

  const alarming = status === "failed" || status === "rescan";

  return (
    <ConsoleField
      data-testid="control-root"
      data-access={owner ? "owner" : "grant"}
      data-revision={baseRevision}
    >
      {/*
        The nameplate. Sticky, because the board's name and the revision it is on
        are the two facts that tell you *which* screen in the house you are about
        to change, and six rows of typing is far enough to scroll to forget.
      */}
      <header
        className="sticky top-0 z-20 -mx-4 mb-3 flex items-center justify-between gap-3 px-4 py-2.5"
        style={{
          backgroundColor: CONSOLE.field,
          boxShadow: `inset 0 -1px 0 ${CONSOLE.hairline}`,
        }}
      >
        <h1
          className="min-w-0 truncate text-[13px] font-medium uppercase"
          style={{ color: CONSOLE.ink, letterSpacing: "0.18em" }}
        >
          {board.name}
        </h1>
        <ConsoleReadout label={t("control.header.rev")} value={baseRevision} />
      </header>

      {status !== "idle" && (
        <div
          className="mb-3 flex items-center gap-2.5 px-3 py-2.5"
          style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
          role="status"
          data-testid="control-status"
          data-status={status}
        >
          {/*
            An indicator lamp, square. Amber is Elektron's attention signal and
            the board's own pigments are reserved for board *data* — a #c3352d
            error bar here would be a red flap where no flap exists.
          */}
          <span
            aria-hidden
            className={cn("size-2 shrink-0", alarming && "bg-destructive")}
            style={alarming ? undefined : { backgroundColor: CONSOLE.amber }}
          />
          <p
            className={cn("text-[11px] font-medium uppercase", alarming && "text-destructive")}
            style={{
              letterSpacing: "0.14em",
              ...(alarming ? {} : { color: CONSOLE.inkDim }),
            }}
          >
            {t(`control.status.${status}`)}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-6 pb-4">
        <MessageEditor onSend={send} pending={pending} />

        {/*
          Below the typed editor, not above it and not instead of it. Voice is the
          headline feature but it is also the one that can be refused by the OS,
          so the path that always works stays first — and the button owns its own
          state line rather than borrowing the header's, because "recording" is a
          continuous condition and that readout reports discrete writes.
        */}
        <PushToTalkButton
          boardId={boardId}
          baseRevision={baseRevision}
          pending={pending}
          onWritten={setWrittenRevision}
        />

        <SoundPackPicker
          soundPack={settings.soundPack}
          muted={settings.muted}
          pending={pending}
          onChange={changeSettings}
        />

        <HistoryStrip
          entries={history.data ?? []}
          loading={history.isLoading}
          pending={pending}
          onReplay={send}
        />
      </div>
    </ConsoleField>
  );
}
