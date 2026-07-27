import { useCallback, useEffect, useRef, useState } from "react";

import {
  decodeRoomState,
  initialState as initialRoomState,
  parseEvent,
  type BoardRoomState,
} from "@/lib/board/protocol";
import type { BoardGrid } from "@/lib/schemas/board";

/**
 * The TV's half of the board protocol: one WebSocket to `/api/board-ws`, a
 * validated grid, and a reconnect policy tuned for a device nobody will ever
 * touch again after mounting it on a wall.
 *
 * Every pure decision in here (backoff, revision ordering, socket URL, "did the
 * board actually change") is exported as a total function so it can be unit
 * tested without a DOM or a socket — the hook itself is only wiring.
 */

export type BoardSocketStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline";

/** First retry lands fast — a TV that just woke should not stare at a stale board. */
export const BACKOFF_BASE_MS = 500;
/** Ceiling on the retry interval: a room that is down stays polled, not hammered. */
export const BACKOFF_CAP_MS = 15_000;
/**
 * How long a post-wake `hello` gets to draw a reply before we assume the socket
 * the OS handed back is a corpse and rebuild it.
 */
export const RESYNC_TIMEOUT_MS = 3_000;

/** Guards `2 ** attempt` from `Infinity` on an absurd attempt count. */
const MAX_BACKOFF_EXPONENT = 30;

const clampUnit = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Exponential backoff with jitter, capped. Jitter is applied over the lower
 * half of the window (`[ceiling/2, ceiling]`) rather than `[0, ceiling]`: a
 * floor keeps a flapping room from being retried in a tight loop, while the
 * spread stops a hall of TVs from reconnecting in lockstep after an outage.
 *
 * `jitter` is injectable so the schedule is deterministic under test.
 */
export const backoffDelay = (attempt: number, jitter = Math.random()): number => {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const exponent = Math.min(safeAttempt, MAX_BACKOFF_EXPONENT);
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  const half = ceiling / 2;
  return Math.round(half + half * clampUnit(jitter));
};

/**
 * Frames can arrive out of order across a reconnect (an old socket's buffered
 * state flushing after a new socket's fresh state). A strictly lower revision is
 * always the past, so it is dropped.
 *
 * Equal revisions are *applied*, deliberately: `soundPack` and `muted` are board
 * settings that the phone changes without minting a new grid revision, so an
 * equal-revision frame is the only way those reach the TV.
 */
export const shouldApplyState = (
  renderedRevision: number,
  incomingRevision: number
): boolean => incomingRevision >= renderedRevision;

/**
 * How many of the 144 cells differ. Drives the flap sound: a re-broadcast of an
 * identical grid (a resync, a settings-only change) must stay silent, or a TV
 * clacks every time it wakes up.
 */
export const changedCellCount = (
  previous: BoardGrid | null,
  next: BoardGrid
): number => {
  if (previous === null) return 0;
  let changed = 0;
  next.rows.forEach((row, rowIndex) => {
    const previousRow = previous.rows[rowIndex];
    row.forEach((cell, colIndex) => {
      const before = previousRow?.[colIndex];
      if (before === undefined) {
        changed += 1;
        return;
      }
      if (before.char !== cell.char || before.color !== cell.color) changed += 1;
    });
  });
  return changed;
};

/**
 * `http(s)` page origin → `ws(s)` room URL. Takes the href rather than reading
 * `window` so it is testable and so a caller can never accidentally build a
 * cross-origin socket. `href` must be an absolute URL (it is always
 * `window.location.href` in practice).
 */
export const boardSocketUrl = (href: string, boardId: string): string => {
  const url = new URL("/api/board-ws", href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.hash = "";
  url.searchParams.set("boardId", boardId);
  return url.toString();
};

/** The handshake frame, pre-serialized — it never varies. */
const HELLO_FRAME = JSON.stringify({ type: "hello" });

export interface UseBoardSocketOptions {
  readonly boardId: string;
  /**
   * Server-rendered state from the loader. Untrusted (it crossed a JSON
   * boundary and may have been written by an older deploy), so it is decoded
   * with `decodeRoomState` and falls back to a blank board.
   */
  readonly initialState?: unknown;
}

export interface UseBoardSocketResult {
  readonly grid: BoardGrid;
  readonly revision: number;
  readonly soundPack: string;
  readonly muted: boolean;
  readonly status: BoardSocketStatus;
}

/** Frames are text in practice; anything else is ignored rather than guessed at. */
const frameFrom = (data: unknown): string | ArrayBuffer | null => {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  return null;
};

export function useBoardSocket({
  boardId,
  initialState,
}: UseBoardSocketOptions): UseBoardSocketResult {
  const [state, setState] = useState<BoardRoomState>(
    () => decodeRoomState(initialState) ?? initialRoomState()
  );
  const [status, setStatus] = useState<BoardSocketStatus>("connecting");

  const applyFrame = useCallback((raw: string | ArrayBuffer) => {
    const event = parseEvent(raw);
    if (event === null || event.type !== "state") return;
    setState((current) =>
      shouldApplyState(current.revision, event.revision)
        ? {
            revision: event.revision,
            grid: event.grid,
            soundPack: event.soundPack,
            muted: event.muted,
          }
        : current
    );
  }, []);

  useEffect(() => {
    if (boardId === "") return;

    // Everything below is per-mount local state. Refs would outlive a boardId
    // change; closures over these do not.
    let alive = true;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let frames = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetry = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };
    const clearResync = () => {
      if (resyncTimer !== null) clearTimeout(resyncTimer);
      resyncTimer = null;
    };

    /** Detach handlers before closing so a teardown can't schedule a retry. */
    const dropSocket = () => {
      const doomed = socket;
      socket = null;
      if (doomed === null) return;
      doomed.onopen = null;
      doomed.onmessage = null;
      doomed.onclose = null;
      doomed.onerror = null;
      if (
        doomed.readyState === WebSocket.OPEN ||
        doomed.readyState === WebSocket.CONNECTING
      ) {
        doomed.close();
      }
    };

    /**
     * A dropped socket while the browser reports no network is "offline", not
     * "reconnecting" — one is worth telling the room about, the other is noise.
     */
    const offlineAware = (): BoardSocketStatus =>
      typeof navigator !== "undefined" && navigator.onLine === false
        ? "offline"
        : "reconnecting";

    const connect = () => {
      if (!alive) return;
      clearRetry();
      clearResync();
      dropSocket();

      const opened = new WebSocket(boardSocketUrl(window.location.href, boardId));
      socket = opened;

      opened.onopen = () => {
        if (!alive || socket !== opened) return;
        attempt = 0;
        setStatus("live");
        opened.send(HELLO_FRAME);
      };

      opened.onmessage = (message: MessageEvent) => {
        if (!alive || socket !== opened) return;
        const frame = frameFrom(message.data);
        if (frame === null) return;
        frames += 1;
        applyFrame(frame);
      };

      const fail = () => {
        if (!alive || socket !== opened) return;
        dropSocket();
        setStatus(offlineAware());
        scheduleRetry();
      };

      opened.onclose = fail;
      opened.onerror = fail;
    };

    const scheduleRetry = () => {
      if (!alive) return;
      clearRetry();
      const delay = backoffDelay(attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    /** Skip the remaining backoff and reconnect now. */
    const reconnectNow = () => {
      if (!alive) return;
      attempt = 0;
      connect();
    };

    /**
     * The Samsung TV suspends the tab; on resume the socket is often already
     * gone, and sometimes it *claims* to be OPEN while being unreachable. So:
     * ask an open socket to resync and give it a deadline, and rebuild anything
     * that isn't open without waiting out the backoff.
     */
    const resync = () => {
      if (!alive) return;
      const current = socket;
      if (current === null || current.readyState !== WebSocket.OPEN) {
        reconnectNow();
        return;
      }
      const before = frames;
      current.send(HELLO_FRAME);
      clearResync();
      resyncTimer = setTimeout(() => {
        if (!alive || frames !== before) return;
        reconnectNow();
      }, RESYNC_TIMEOUT_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") resync();
    };
    const onOnline = () => resync();
    const onOffline = () => {
      if (alive) setStatus("offline");
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    setStatus("connecting");
    connect();

    return () => {
      alive = false;
      clearRetry();
      clearResync();
      dropSocket();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [applyFrame, boardId]);

  return {
    grid: state.grid,
    revision: state.revision,
    soundPack: state.soundPack,
    muted: state.muted,
    status,
  };
}
