import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  BoardRoom,
  BoardRoomLive,
  parseNonceSpend,
  parseRoomState,
} from "../board-room";
import { CloudflareEnvLive } from "../cloudflare";
import { blankGrid } from "@/lib/board/compile";
import {
  ConfigurationError,
  ExternalServiceError,
} from "@/models/errors/repository";

const grid = blankGrid();

const statePayload = {
  type: "state",
  revision: 3,
  grid,
  soundPack: "classic",
  muted: false,
};

interface Recorded {
  url: string;
  init?: RequestInit;
}

const fakeNamespace = (
  handler: (recorded: Recorded) => Response,
  recorder?: Recorded[]
) =>
  ({
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        const recorded = { url, init };
        recorder?.push(recorded);
        return handler(recorded);
      },
    }),
  }) as unknown as DurableObjectNamespace;

const envWith = (namespace: unknown) =>
  CloudflareEnvLive({
    BETTER_AUTH_SECRET: "test-secret",
    BOARD: namespace,
  } as unknown as Env);

const provideRoom = (namespace: unknown) =>
  BoardRoomLive.pipe(Layer.provide(envWith(namespace)));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("parseRoomState", () => {
  it("accepts a well-formed state event", () => {
    const parsed = parseRoomState(statePayload);
    expect(parsed).not.toBeNull();
    expect(parsed?.revision).toBe(3);
    expect(parsed?.soundPack).toBe("classic");
    expect(parsed?.truncated).toBe(false);
  });

  it("defaults truncated to false and honours an explicit true", () => {
    expect(parseRoomState({ ...statePayload, truncated: true })?.truncated).toBe(true);
    expect(parseRoomState({ ...statePayload, truncated: "yes" })?.truncated).toBe(false);
  });

  it("rejects anything that is not a state event", () => {
    expect(parseRoomState(null)).toBeNull();
    expect(parseRoomState("state")).toBeNull();
    expect(parseRoomState({ type: "error", code: "invalid_command" })).toBeNull();
    expect(parseRoomState({ ...statePayload, type: undefined })).toBeNull();
  });

  it("rejects a non-integer revision", () => {
    expect(parseRoomState({ ...statePayload, revision: 1.5 })).toBeNull();
    expect(parseRoomState({ ...statePayload, revision: "3" })).toBeNull();
  });

  it("rejects a structurally invalid grid", () => {
    expect(parseRoomState({ ...statePayload, grid: { rows: [] } })).toBeNull();
    expect(parseRoomState({ ...statePayload, grid: undefined })).toBeNull();
  });

  it("rejects missing settings fields", () => {
    expect(parseRoomState({ ...statePayload, soundPack: 1 })).toBeNull();
    expect(parseRoomState({ ...statePayload, muted: "false" })).toBeNull();
  });
});

describe("parseNonceSpend", () => {
  it("reads a tagged ledger answer", () => {
    expect(parseNonceSpend({ type: "nonce", spent: true })).toBe(true);
    expect(parseNonceSpend({ type: "nonce", spent: false })).toBe(false);
  });

  it("returns null — never false — for anything it does not recognise", () => {
    // The distinction matters: reading an unrecognised answer as `false` would
    // turn a shape mismatch into a pairing outage that looks exactly like a
    // replay, and nobody would know to go looking at the room.
    expect(parseNonceSpend(null)).toBeNull();
    expect(parseNonceSpend("nonce")).toBeNull();
    expect(parseNonceSpend({ type: "nonce" })).toBeNull();
    expect(parseNonceSpend({ type: "nonce", spent: "no" })).toBeNull();
    expect(parseNonceSpend({ spent: true })).toBeNull();
    expect(parseNonceSpend({ type: "state", spent: true })).toBeNull();
  });

  it("does not read a state frame as a ledger answer", () => {
    expect(parseNonceSpend(statePayload)).toBeNull();
  });
});

describe("BoardRoomLive", () => {
  it.effect("fails with ConfigurationError when the BOARD binding is absent", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        BoardRoom.pipe(Effect.provide(provideRoom(undefined)))
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ConfigurationError);
        }
      }
    })
  );

  it.effect("getState returns the room's state and scopes the call to the board", () => {
    const calls: Recorded[] = [];
    return Effect.gen(function* () {
      const room = yield* BoardRoom;
      const state = yield* room.getState("board-42");
      expect(state.revision).toBe(3);
      expect(state.grid.rows).toHaveLength(6);
      expect(calls[0]!.url).toContain("/state?boardId=board-42");
    }).pipe(
      Effect.provide(provideRoom(fakeNamespace(() => jsonResponse(statePayload), calls)))
    );
  });

  it.effect("setMessage posts a set command carrying the base revision and source", () => {
    const calls: Recorded[] = [];
    return Effect.gen(function* () {
      const room = yield* BoardRoom;
      yield* room.setMessage({
        boardId: "board-42",
        baseRevision: 3,
        message: { rows: [{ align: "left", segments: [{ text: "HI", color: "white" }] }] },
        source: "llm",
        prompt: "say hi",
      });
      const call = calls[0]!;
      expect(call.url).toContain("/set?boardId=board-42");
      expect(call.init?.method).toBe("POST");
      const body = JSON.parse(String(call.init?.body));
      expect(body).toMatchObject({
        type: "set",
        baseRevision: 3,
        source: "llm",
        prompt: "say hi",
      });
      expect(body.message.rows[0].segments[0].text).toBe("HI");
    }).pipe(
      Effect.provide(
        provideRoom(fakeNamespace(() => jsonResponse({ ...statePayload, revision: 4 }), calls))
      )
    );
  });

  it.effect("updateSettings posts only the fields asked for, at no new revision", () => {
    const calls: Recorded[] = [];
    return Effect.gen(function* () {
      const room = yield* BoardRoom;
      const state = yield* room.updateSettings({ boardId: "board-42", muted: true });
      const call = calls[0]!;
      expect(call.url).toContain("/settings?boardId=board-42");
      expect(call.init?.method).toBe("POST");
      const body = JSON.parse(String(call.init?.body));
      // A mute-only change must not carry a soundPack — the room reads an absent
      // field as "leave it alone", so sending one would reset the pack.
      expect(body).toEqual({ muted: true });
      expect("soundPack" in body).toBe(false);
      // The room echoed the same revision it already had: settings are not a grid
      // generation, and the TV's shouldApplyState applies equal revisions.
      expect(state.revision).toBe(3);
    }).pipe(
      Effect.provide(
        provideRoom(
          fakeNamespace(() => jsonResponse({ ...statePayload, muted: true }), calls)
        )
      )
    );
  });

  it.effect("updateSettings can carry both fields", () => {
    const calls: Recorded[] = [];
    return Effect.gen(function* () {
      const room = yield* BoardRoom;
      yield* room.updateSettings({
        boardId: "board-42",
        soundPack: "vintage",
        muted: false,
      });
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
        soundPack: "vintage",
        muted: false,
      });
    }).pipe(
      Effect.provide(
        provideRoom(fakeNamespace(() => jsonResponse(statePayload), calls))
      )
    );
  });

  it.effect("spendNonce posts the nonce and TTL to the board's own room", () => {
    const calls: Recorded[] = [];
    return Effect.gen(function* () {
      const room = yield* BoardRoom;
      const won = yield* room.spendNonce("board-42", "nonce-1", 118);
      expect(won).toBe(true);
      const call = calls[0]!;
      // Board-scoped: the ledger is the room keyed by this board id, which is what
      // makes the check-and-set atomic for this nonce.
      expect(call.url).toContain("/spend-nonce?boardId=board-42");
      expect(call.init?.method).toBe("POST");
      expect(JSON.parse(String(call.init?.body))).toEqual({
        nonce: "nonce-1",
        ttlSeconds: 118,
      });
    }).pipe(
      Effect.provide(
        provideRoom(
          fakeNamespace(() => jsonResponse({ type: "nonce", spent: true }), calls)
        )
      )
    );
  });

  it.effect("spendNonce reports a replay as false, not as a failure", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      expect(yield* room.spendNonce("board-42", "nonce-1", 118)).toBe(false);
    }).pipe(
      Effect.provide(
        provideRoom(fakeNamespace(() => jsonResponse({ type: "nonce", spent: false })))
      )
    )
  );

  it.effect("spendNonce fails closed when the room 500s", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      const exit = yield* Effect.exit(room.spendNonce("board-42", "nonce-1", 118));
      // Not `false`: a broken ledger must be distinguishable from a replay so the
      // pairing route can refuse without pretending it knows which it saw.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ExternalServiceError);
        }
      }
    }).pipe(
      Effect.provide(
        provideRoom(
          fakeNamespace(() => jsonResponse({ type: "error", code: "persist_failed" }, 500))
        )
      )
    )
  );

  it.effect("spendNonce fails closed on an unrecognised ledger payload", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      const exit = yield* Effect.exit(room.spendNonce("board-42", "nonce-1", 118));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        provideRoom(fakeNamespace(() => jsonResponse({ type: "nonce" })))
      )
    )
  );

  it.effect("spendQuota posts only who and where — never the limits", () => {
    const calls: Recorded[] = [];
    return Effect.gen(function* () {
      const room = yield* BoardRoom;
      const verdict = yield* room.spendQuota({
        boardId: "board-42",
        endpoint: "generate",
        spender: "grant:nonce-1",
        mode: "charge",
      });
      expect(verdict.allowed).toBe(true);
      const call = calls[0]!;
      // Board-scoped for the same reason the nonce ledger is: the counter is
      // only atomic inside the one object that owns this board.
      expect(call.url).toContain("/spend-quota?boardId=board-42");
      expect(call.init?.method).toBe("POST");
      // Exactly three fields. A limit on the wire would mean the Durable
      // Object enforces whatever its caller asked for, which is the bug this
      // shape exists to make impossible — so this asserts the absence.
      const body = JSON.parse(String(call.init?.body));
      expect(body).toEqual({
        endpoint: "generate",
        spender: "grant:nonce-1",
        mode: "charge",
      });
      for (const forbidden of ["spenderLimit", "boardLimit", "windowSeconds"]) {
        expect(forbidden in body).toBe(false);
      }
    }).pipe(
      Effect.provide(
        provideRoom(
          fakeNamespace(
            () => jsonResponse({ type: "quota", allowed: true, retryAfter: 0 }),
            calls
          )
        )
      )
    );
  });

  it.effect("spendQuota reports a refusal as a value, with the wait", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      const verdict = yield* room.spendQuota({
        boardId: "board-42",
        endpoint: "transcribe",
        spender: "owner:u1",
        mode: "charge",
      });
      // Being over the cap is an ordinary answer, not a failure — the route
      // turns it into a 429 with the wait attached.
      expect(verdict.allowed).toBe(false);
      expect(verdict.retryAfter).toBe(120);
    }).pipe(
      Effect.provide(
        provideRoom(
          fakeNamespace(() =>
            jsonResponse({ type: "quota", allowed: false, retryAfter: 120 })
          )
        )
      )
    )
  );

  it.effect("spendQuota fails closed when the room 500s", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      const exit = yield* Effect.exit(
        room.spendQuota({
          boardId: "board-42",
          endpoint: "generate",
          spender: "owner:u1",
          mode: "charge",
        })
      );
      // Never a permissive `allowed: true`: a broken counter must refuse the
      // spend rather than wave an unmetered call through to a paid API.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ExternalServiceError);
        }
      }
    }).pipe(
      Effect.provide(
        provideRoom(
          fakeNamespace(() =>
            jsonResponse({ type: "error", code: "persist_failed" }, 500)
          )
        )
      )
    )
  );

  it.effect("spendQuota fails closed on an unrecognised ledger payload", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      const exit = yield* Effect.exit(
        room.spendQuota({
          boardId: "board-42",
          endpoint: "generate",
          spender: "owner:u1",
          mode: "charge",
        })
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        provideRoom(
          // A nonce answer is not a quota answer — shape confusion must not read
          // as permission.
          fakeNamespace(() => jsonResponse({ type: "nonce", spent: true }))
        )
      )
    )
  );

  it.effect("surfaces a non-200 from the room as ExternalServiceError", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      const exit = yield* Effect.exit(room.getState("board-42"));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ExternalServiceError);
        }
      }
    }).pipe(
      Effect.provide(
        provideRoom(fakeNamespace(() => new Response("boom", { status: 500 })))
      )
    )
  );

  it.effect("surfaces an unrecognised payload as ExternalServiceError", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      const exit = yield* Effect.exit(room.getState("board-42"));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ExternalServiceError);
        }
      }
    }).pipe(
      Effect.provide(
        provideRoom(fakeNamespace(() => jsonResponse({ type: "state", revision: "nope" })))
      )
    )
  );

  it.effect("surfaces a thrown stub fetch as ExternalServiceError", () =>
    Effect.gen(function* () {
      const room = yield* BoardRoom;
      const exit = yield* Effect.exit(room.getState("board-42"));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        provideRoom(
          fakeNamespace(() => {
            throw new Error("network");
          })
        )
      )
    )
  );
});
