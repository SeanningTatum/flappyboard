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
import { BoardGridView } from "@/components/board/board-grid-view";
import { MessageEditor } from "@/components/board/message-editor";
import { PushToTalkButton } from "@/components/board/push-to-talk-button";
import { SoundPackPicker } from "@/components/board/sound-pack-picker";
import { HistoryStrip } from "@/components/board/history-strip";
import {
  CONSOLE,
  ConsoleField,
  ConsoleReadout,
  PLATE_LIP,
  SegmentTrack,
  segmentClass,
  segmentStyle,
} from "@/components/board/console";
import { ConsoleShell } from "@/components/board/console-shell";
import { ControllerSettings } from "@/components/board/controller-settings";
import type { BoardMessage } from "@/lib/schemas/board";
// The scoped token override for the console surfaces. See the header of that
// file for why this route runs its own visual language.
import "./hardware-theme.css";
import flapFont from "@/assets/fonts/inter-flap-600.woff2?url";

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

export const handle = { i18n: ["board", "boards"] };

/**
 * The controller renders the board — live off the socket when there is nothing
 * composed, the compiled draft when there is — so it needs the flap face for the
 * same reason the display does. See the note on the display route's `links`.
 */
export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    href: flapFont,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

/**
 * The controller is a dark console in a dim room — declare it so the phone's
 * own chrome (address bar, scrollbars, form controls) matches instead of
 * flashing white between the TV and this page.
 */
export const meta: Route.MetaFunction = () => [
  { name: "color-scheme", content: "dark" },
  { name: "theme-color", content: CONSOLE.field },
];

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
    deviceName: null,
    board: null,
    state: null,
    displayUrl: `${url.origin}/b/${encodeURIComponent(boardId)}`,
    user: null,
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

  /*
    The owner's name, for the shell's account menu — and `null` for a grant,
    which has no session at all. This is the only reason the loader touches
    Better Auth: `claim` already decided authority, and re-deriving it here
    would create a second answer to the same question.
  */
  const session =
    claimed.value.access === "owner"
      ? await context.auth.api.getSession({ headers: request.headers })
      : null;

  return data({
    boardId,
    access: claimed.value.access,
    // Null until the phone names itself (or named itself at pairing). The
    // naming offer used to be a one-time prompt wedged above the editor; it now
    // lives inline in the Settings tab, so this is a value rather than a
    // trigger — see `controller-settings.tsx`.
    deviceName: claimed.value.deviceName,
    board: claimed.value.board,
    state: claimed.value.state,
    // The address a television is pointed at to show this board. Built from the
    // request so it is right on localhost, preview and production alike.
    displayUrl: `${url.origin}/b/${encodeURIComponent(boardId)}`,
    user:
      session === null
        ? null
        : {
            name: session.user.name,
            isAdmin: session.user.role === "admin",
          },
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
      deviceName={loaderData.deviceName}
      displayUrl={loaderData.displayUrl}
      user={loaderData.user}
      board={board}
      state={state}
    />
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
      // Only the additions — `ConsoleField` merges now, so restating its own
      // layout string here would just be two places to keep in step.
      className="items-center justify-center gap-5 text-center"
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
  /**
   * What the room calls this device, straight from `claim`. `null` for an
   * owner session (no record to name) and for a phone that never gave one —
   * the second case is what the Settings tab's naming field exists to fix.
   */
  readonly deviceName: string | null;
  /** Absolute URL a television is pointed at to show this board. */
  readonly displayUrl: string;
  /** The owner's account, for the shell. `null` for a grant — it has none. */
  readonly user: { readonly name: string; readonly isAdmin: boolean } | null;
  readonly board: {
    readonly name: string;
    readonly soundPack: string;
    readonly muted: boolean;
    readonly revision: number;
  };
  readonly state: { readonly revision: number };
}

function Controller({
  boardId,
  owner,
  deviceName,
  displayUrl,
  user,
  board,
  state,
}: ControllerProps) {
  const { t } = useTranslation("board");
  // The tabs, the shell and everything under Settings come from the `boards`
  // namespace — the same bundle the rack uses, so the rename dialog's copy did
  // not have to be duplicated when the dialog moved onto this page.
  const { t: tBoards } = useTranslation("boards");
  const utils = api.useUtils();

  /** Which tab is showing. Session-local: a reload is a fresh Content tab. */
  const [tab, setTab] = useState<"content" | "settings">("content");

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

  /*
    Two pieces of state used to live here and no longer do.

    `namePromptOpen` drove a one-time "name this phone" card that appeared above
    the editor on a grant's first visit. It was a modal-shaped interruption
    standing between somebody and the thing they scanned a QR code to do, and
    naming a phone is not urgent — it is a setting. It is now a plain field in
    the Settings tab, pre-filled from `deviceName`, which is also where the
    owner's list of those names is.

    `mirrorOpen` collapsed the live board. See the comment at the mirror itself.
  */

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
        The account bar, owner only — a grant-holding phone has no session to
        sign out of and no rack to go back to. This is where a non-admin can
        finally sign out; before this existed the only control in the app was
        inside the admin sidebar, behind a role gate.
      */}
      {user !== null && (
        <ConsoleShell
          back={{ to: "/boards", label: tBoards("controller.back") }}
          userName={user.name}
          isAdmin={user.isAdmin}
        />
      )}

      {/*
        The nameplate. Sticky, because the board's name and the revision it is on
        are the two facts that tell you *which* screen in the house you are about
        to change, and six rows of typing is far enough to scroll to forget.
      */}
      <header
        className={cn(
          "sticky z-20 -mx-4 flex items-center justify-between gap-3 px-4 py-2.5",
          // Under the account bar when there is one, at the top when there is
          // not. Both are sticky, so the offset has to be stated rather than
          // inherited.
          user === null ? "top-0" : "top-[3.25rem]"
        )}
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

      {/*
        Content | Settings.

        Two tabs rather than two routes, and the path stays exactly
        `/b/:boardId/c`: the television mints its controller QR from its own
        loader, so a path change only reaches a TV that reloads — and a
        wall-mounted panel may never have to. A tab is free; a new URL is a
        promise to every screen already showing the old one.

        Rendered as the console's own segmented track (a recessed groove with
        the active half raised), not as pills. `SegmentTrack` is the same
        primitive `/link` used for its intent switch.
      */}
      <div className="my-3">
        <SegmentTrack>
          {(["content", "settings"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              // `segmentClass` sizes nothing — every other track in the app
              // adds its own width and height, and without them two tabs
              // collapse to their text and huddle at the left of the groove.
              className={cn(segmentClass(tab === value), "h-11 flex-1 touch-manipulation")}
              style={segmentStyle(tab === value)}
              data-testid={`control-tab-${value}`}
            >
              {tBoards(`controller.tabs.${value}`)}
            </button>
          ))}
        </SegmentTrack>
      </div>

      {tab === "settings" ? (
        <ControllerSettings
          boardId={boardId}
          boardName={board.name}
          owner={owner}
          deviceName={deviceName}
          displayUrl={displayUrl}
        />
      ) : (
        <>
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
        {/*
          The live board used to be its own collapsible section, directly above
          the editor — which put TWO board renders on one phone screen, one
          showing what is on the wall and one showing what you are typing, a
          hand's width apart. On a 390px viewport that is not a preview, it is a
          spot-the-difference puzzle.

          So the mirror is gone as a section and the *editor's* grid became the
          single instrument: it shows the live board while there is nothing to
          compose, and your draft the moment there is. Same place, same size, one
          answer to "what will this screen say". The socket's grid is passed
          straight in — see `MessageEditor`.
        */}
        <MessageEditor
          liveGrid={live.grid}
          onSend={send}
          pending={pending}
        />

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
        </>
      )}
    </ConsoleField>
  );
}
