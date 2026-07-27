import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  BOARD_AGENT_MAX_ATTEMPTS,
  BOARD_AGENT_MODEL,
  BOARD_AGENT_SYSTEM_PROMPT,
  BOARD_MESSAGE_JSON_SCHEMA,
  BoardAgent,
  BoardAgentLive,
  makeBoardAgent,
  renderGridForPrompt,
  retryTurn,
  unconfiguredBoardAgent,
  type BoardAgentClient,
} from "../board-agent";
import { CloudflareEnvLive } from "../cloudflare";
import { blankGrid, compileToGrid } from "@/lib/board/compile";
import { BOARD_ALIGNS, BOARD_COLS, BOARD_ROWS } from "@/lib/schemas/board";
import { ConfigurationError } from "@/models/errors/repository";

/* -------------------------------------------------------------------------- */
/* Stubs — no network anywhere in this file                                   */
/* -------------------------------------------------------------------------- */

/** A minimal SDK-shaped response. Only the fields the service reads are real. */
const reply = (
  text: string,
  stopReason: Anthropic.Message["stop_reason"] = "end_turn"
): Anthropic.Message =>
  ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: BOARD_AGENT_MODEL,
    stop_reason: stopReason,
    stop_details: null,
    content: [{ type: "text", text, citations: null }],
  }) as unknown as Anthropic.Message;

const refusal = (
  category: "cyber" | "bio" | null = "cyber"
): Anthropic.Message =>
  ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: BOARD_AGENT_MODEL,
    stop_reason: "refusal",
    stop_details: { type: "refusal", category, explanation: "nope" },
    // Deliberately empty: a refusal carries no content, which is exactly why the
    // service must check `stop_reason` before reading it.
    content: [],
  }) as unknown as Anthropic.Message;

interface Recorded {
  readonly calls: Array<Anthropic.MessageCreateParamsNonStreaming>;
}

/**
 * Plays the given replies in order (the last one repeats), recording every
 * request so the tests can assert on what the model was actually told.
 */
const stubClient = (
  replies: ReadonlyArray<Anthropic.Message | Error>
): { client: BoardAgentClient; recorded: Recorded } => {
  const recorded: Recorded = { calls: [] };
  const client: BoardAgentClient = (params) => {
    recorded.calls.push(params);
    const next = replies[Math.min(recorded.calls.length - 1, replies.length - 1)]!;
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(next);
  };
  return { client, recorded };
};

const VALID = JSON.stringify({
  rows: [
    { align: "center", segments: [{ text: "GOOD MORNING", color: "yellow" }] },
    { align: "center", segments: [{ text: "    ", color: "red" }] },
  ],
});

const lastUserText = (
  params: Anthropic.MessageCreateParamsNonStreaming
): string => {
  const last = params.messages[params.messages.length - 1]!;
  return typeof last.content === "string" ? last.content : "";
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("unreachable");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("unreachable");
  return failure.value;
};

/* -------------------------------------------------------------------------- */

describe("renderGridForPrompt", () => {
  it("reports a blank board as blank rather than six empty rails", () => {
    expect(renderGridForPrompt(blankGrid())).toBe(
      "(the board is currently blank)"
    );
  });

  it("renders one delimited line per row and lists the colours in use", () => {
    const grid = compileToGrid({
      rows: [
        { align: "left", segments: [{ text: "HI", color: "green" }] },
        { align: "left", segments: [{ text: "  ", color: "red" }] },
      ],
    });
    const rendered = renderGridForPrompt(grid);
    const lines = rendered.split("\n");
    expect(lines).toHaveLength(BOARD_ROWS);
    expect(lines[0]).toBe(`|HI${" ".repeat(BOARD_COLS - 2)}|  [green]`);
    // A coloured space is a lit tile, so the colour must show up even though the
    // row has no readable text.
    expect(lines[1]).toContain("[red]");
    // Unlit rows carry no colour annotation.
    expect(lines[5]).toBe(`|${" ".repeat(BOARD_COLS)}|`);
  });
});

/**
 * The prompt and the JSON schema are the *only* things standing between the model
 * and a hand-padded row, so the affordances it cannot discover on its own are
 * asserted rather than trusted to survive an edit.
 */
describe("BoardAgent instructions", () => {
  it("lets the model choose spread — the schema is the harder constraint", () => {
    const at = (node: unknown, ...path: ReadonlyArray<string>): unknown =>
      path.reduce<unknown>(
        (value, key) => (value as Record<string, unknown>)[key],
        node
      );

    const align = at(
      BOARD_MESSAGE_JSON_SCHEMA,
      "properties",
      "rows",
      "items",
      "properties",
      "align",
      "enum"
    );
    // Derived from the schema, so a fifth alignment cannot be added to one and
    // silently withheld from the model.
    expect(align).toEqual([...BOARD_ALIGNS]);
    expect(align).toContain("spread");
  });

  it("names spread and forbids the space-padding it replaces", () => {
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain('"align": "spread"');
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("NEVER pad with spaces");
  });

  it("tells the model to name the subject the request named", () => {
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("OSLO WEATHER");
  });

  it("describes the board as a grid it can draw on, with a full-width bar", () => {
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain(
      `${BOARD_ROWS} rows × ${BOARD_COLS} columns`
    );
    // The worked frame example carries a literal 24-space segment, which is the
    // shape a model does not guess.
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain(`"${" ".repeat(BOARD_COLS)}"`);
  });

  it("scopes the colour-block rule to all-space segments, not to every space", () => {
    // `compile.ts` lights a coloured space only in a segment made entirely of
    // spaces. A prompt that still said "a SPACE in any colour is a lit tile" would
    // be teaching the model the `HAPPY#FRIDAY!` defect.
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("NOTHING BUT SPACES");
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("the gaps between its words stay unlit");
  });

  it("asks for restraint, so a plain message does not get a frame", () => {
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("A plain message stays plain");
  });
});

describe("BoardAgent request shape", () => {
  it.effect("sends the model, system prompt and enforced JSON schema — and no sampling params", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply(VALID)]);
      yield* makeBoardAgent(client).generate({
        prompt: "good morning",
        current: blankGrid(),
      });

      const params = recorded.calls[0]!;
      expect(params.model).toBe(BOARD_AGENT_MODEL);
      expect(params.system).toBe(BOARD_AGENT_SYSTEM_PROMPT);
      expect(params.output_config?.format).toEqual({
        type: "json_schema",
        schema: BOARD_MESSAGE_JSON_SCHEMA,
      });
      // claude-sonnet-5 rejects these with a 400 — they must never be sent.
      expect(params).not.toHaveProperty("temperature");
      expect(params).not.toHaveProperty("top_p");
      expect(params).not.toHaveProperty("top_k");
    })
  );

  it.effect("includes the current board so a follow-up prompt can edit it", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply(VALID)]);
      const current = compileToGrid({
        rows: [{ align: "left", segments: [{ text: "MONDAY", color: "blue" }] }],
      });
      yield* makeBoardAgent(client).generate({
        prompt: "make it funnier",
        current,
      });

      const sent = lastUserText(recorded.calls[0]!);
      expect(sent).toContain("MONDAY");
      expect(sent).toContain("[blue]");
      expect(sent).toContain("make it funnier");
    })
  );
});

describe("BoardAgent happy path", () => {
  it.effect("decodes on the first attempt and compiles to a 6x24 grid", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply(VALID)]);
      const result = yield* makeBoardAgent(client).generate({
        prompt: "good morning",
        current: blankGrid(),
      });

      expect(recorded.calls).toHaveLength(1);
      expect(result.attempts).toBe(1);
      expect(result.repaired).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.grid.rows).toHaveLength(BOARD_ROWS);
      for (const row of result.grid.rows) {
        expect(row).toHaveLength(BOARD_COLS);
      }
      expect(result.grid.rows[0]!.map((c) => c.char).join("")).toContain(
        "GOOD MORNING"
      );
    })
  );

  it.effect("surfaces compileMessage's truncated flag when content is lost", () =>
    Effect.gen(function* () {
      const tooTall = JSON.stringify({
        rows: Array.from({ length: BOARD_ROWS }, () => ({
          align: "left",
          // Each row wraps to two board rows, so 6 semantic rows produce 12
          // lines and half of them are dropped.
          segments: [{ text: "A".repeat(BOARD_COLS + 5), color: "white" }],
        })),
      });
      const { client } = stubClient([reply(tooTall)]);
      const result = yield* makeBoardAgent(client).generate({
        prompt: "lots of text",
        current: blankGrid(),
      });

      expect(result.repaired).toBe(false);
      expect(result.truncated).toBe(true);
      expect(result.grid.rows).toHaveLength(BOARD_ROWS);
    })
  );
});

describe("BoardAgent retry", () => {
  it.effect("retries after malformed JSON and succeeds on the second attempt", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([
        reply("{ rows: [oops"),
        reply(VALID),
      ]);
      const result = yield* makeBoardAgent(client).generate({
        prompt: "good morning",
        current: blankGrid(),
      });

      expect(recorded.calls).toHaveLength(2);
      expect(result.attempts).toBe(2);
      expect(result.repaired).toBe(false);
      expect(result.grid.rows[0]!.map((c) => c.char).join("")).toContain(
        "GOOD MORNING"
      );
    })
  );

  it.effect("feeds the decode error back into the retry prompt", () =>
    Effect.gen(function* () {
      // Decodes as JSON but not as a BoardMessage — so the fed-back text is a
      // schema error, which is the case worth proving.
      const { client, recorded } = stubClient([
        reply(JSON.stringify({ rows: "nope" })),
        reply(VALID),
      ]);
      yield* makeBoardAgent(client).generate({
        prompt: "good morning",
        current: blankGrid(),
      });

      const retry = recorded.calls[1]!;
      // The conversation grew by the model's own bad answer plus the correction.
      expect(retry.messages).toHaveLength(3);
      expect(retry.messages[1]!.role).toBe("assistant");
      expect(retry.messages[1]!.content).toContain("nope");

      const correction = lastUserText(retry);
      expect(correction).toContain("did not decode as a board message");
      // The actual ParseError text, not just a generic scolding.
      expect(correction).toContain("rows");
      expect(correction.length).toBeGreaterThan(retryTurn("").length);
    })
  );

  it.effect("carries a not-JSON error back too", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply("I'm afraid I can't"), reply(VALID)]);
      yield* makeBoardAgent(client).generate({
        prompt: "hello",
        current: blankGrid(),
      });
      expect(lastUserText(recorded.calls[1]!)).toContain("not valid JSON");
    })
  );
});

describe("BoardAgent repair fallback", () => {
  it.effect("stops after the attempt cap and repairs the last response", () =>
    Effect.gen(function* () {
      // Structurally wrong every time: `segments` is a bare string, which
      // `repairMessage` can still salvage into one segment.
      const salvageable = JSON.stringify({
        rows: [{ align: "left", segments: "HELLO WORLD" }],
      });
      const { client, recorded } = stubClient([reply(salvageable)]);
      const result = yield* makeBoardAgent(client).generate({
        prompt: "say hello",
        current: blankGrid(),
      });

      expect(recorded.calls).toHaveLength(BOARD_AGENT_MAX_ATTEMPTS);
      expect(result.attempts).toBe(BOARD_AGENT_MAX_ATTEMPTS);
      expect(result.repaired).toBe(true);
      expect(result.grid.rows).toHaveLength(BOARD_ROWS);
      expect(result.grid.rows[0]!.map((c) => c.char).join("")).toContain(
        "HELLO WORLD"
      );
    })
  );

  it.effect("degrades a response that is not JSON at all to clipped text", () =>
    Effect.gen(function* () {
      // The pathological case: three non-JSON responses. The board must still
      // render — a failed request is not an acceptable outcome.
      const { client } = stubClient([reply("JUST SOME PROSE")]);
      const result = yield* makeBoardAgent(client).generate({
        prompt: "anything",
        current: blankGrid(),
      });

      expect(result.repaired).toBe(true);
      expect(result.grid.rows).toHaveLength(BOARD_ROWS);
      expect(result.grid.rows[0]!.map((c) => c.char).join("")).toContain(
        "JUST SOME"
      );
    })
  );
});

describe("BoardAgent failures", () => {
  it.effect("stop_reason 'refusal' fails with LlmRefusedError before reading content", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([refusal("cyber")]);
      const exit = yield* Effect.exit(
        makeBoardAgent(client).generate({
          prompt: "something disallowed",
          current: blankGrid(),
        })
      );

      const error = failureOf(exit);
      expect(error._tag).toBe("LlmRefusedError");
      expect(error).toMatchObject({ category: "cyber" });
      // A refusal is terminal — retrying the same prompt cannot help.
      expect(recorded.calls).toHaveLength(1);
    })
  );

  it.effect("a thrown API error fails with BoardGenerationError", () =>
    Effect.gen(function* () {
      const { client } = stubClient([new Error("429 rate_limit_error")]);
      const exit = yield* Effect.exit(
        makeBoardAgent(client).generate({
          prompt: "good morning",
          current: blankGrid(),
        })
      );

      const error = failureOf(exit);
      expect(error._tag).toBe("BoardGenerationError");
      expect(error).toMatchObject({ stage: "request" });
    })
  );

  it.effect("an empty response fails with BoardGenerationError rather than decoding ''", () =>
    Effect.gen(function* () {
      const { client } = stubClient([reply("", "max_tokens")]);
      const exit = yield* Effect.exit(
        makeBoardAgent(client).generate({
          prompt: "good morning",
          current: blankGrid(),
        })
      );

      const error = failureOf(exit);
      expect(error._tag).toBe("BoardGenerationError");
      expect(error).toMatchObject({ stage: "empty" });
    })
  );
});

describe("BoardAgentLive", () => {
  it.effect("a missing ANTHROPIC_API_KEY fails generate with ConfigurationError", () =>
    Effect.gen(function* () {
      const agent = yield* BoardAgent;
      const exit = yield* Effect.exit(
        agent.generate({ prompt: "good morning", current: blankGrid() })
      );
      const error = failureOf(exit);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({
        service: "BoardAgent",
        field: "ANTHROPIC_API_KEY",
      });
    }).pipe(
      Effect.provide(
        BoardAgentLive.pipe(
          Layer.provide(CloudflareEnvLive({} as unknown as Env))
        )
      )
    )
  );

  it.effect("constructs successfully without a key, so one missing secret cannot 500 the whole app", () =>
    Effect.gen(function* () {
      const agent = yield* BoardAgent;
      expect(typeof agent.generate).toBe("function");
    }).pipe(
      Effect.provide(
        BoardAgentLive.pipe(
          Layer.provide(CloudflareEnvLive({} as unknown as Env))
        )
      )
    )
  );

  it.effect("builds a real agent when the key is present", () =>
    Effect.gen(function* () {
      const agent = yield* BoardAgent;
      // Not `unconfiguredBoardAgent` — the live client was constructed. No call
      // is made, so nothing touches the network.
      expect(agent).not.toBe(unconfiguredBoardAgent);
    }).pipe(
      Effect.provide(
        BoardAgentLive.pipe(
          Layer.provide(
            CloudflareEnvLive({
              ANTHROPIC_API_KEY: "sk-ant-test",
            } as unknown as Env)
          )
        )
      )
    )
  );
});
