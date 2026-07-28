import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  BOARD_AGENT_MAX_ATTEMPTS,
  BOARD_AGENT_MAX_PAUSES,
  BOARD_AGENT_MODEL,
  BOARD_AGENT_SYSTEM_PROMPT,
  BOARD_AGENT_SYSTEM_PROMPT_NO_SEARCH,
  BOARD_AGENT_TOOLS,
  BOARD_MESSAGE_JSON_SCHEMA,
  BOARD_ROUTER_MODEL,
  BoardAgent,
  BoardAgentLive,
  makeBoardAgent,
  makeBoardAgentLive,
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

/** A router reply: one boolean of JSON, in the shape Haiku is asked for. */
const routed = (needsLiveData: boolean): Anthropic.Message =>
  ({
    id: "msg_router",
    type: "message",
    role: "assistant",
    model: BOARD_ROUTER_MODEL,
    stop_reason: "end_turn",
    stop_details: null,
    content: [
      {
        type: "text",
        text: JSON.stringify({ needs_live_data: needsLiveData }),
        citations: null,
      },
    ],
  }) as unknown as Anthropic.Message;

interface Recorded {
  /** Board calls only, so index-based assertions read as attempts. */
  readonly calls: Array<Anthropic.MessageCreateParamsNonStreaming>;
  /** The routing calls, kept separately because they are not attempts. */
  readonly routerCalls: Array<Anthropic.MessageCreateParamsNonStreaming>;
}

/**
 * Plays the given replies in order (the last one repeats), recording every
 * request so the tests can assert on what the model was actually told.
 *
 * The router call is answered separately and does **not** consume a reply, so a
 * test can keep talking about "the first attempt" without counting the routing
 * round trip. `route` controls what the router says; pass an `Error` or a
 * non-JSON message to exercise the fail-open path.
 */
const stubClient = (
  replies: ReadonlyArray<Anthropic.Message | Error>,
  route: Anthropic.Message | Error = routed(true)
): { client: BoardAgentClient; recorded: Recorded } => {
  const recorded: Recorded = { calls: [], routerCalls: [] };
  const client: BoardAgentClient = (params) => {
    if (params.model === BOARD_ROUTER_MODEL) {
      recorded.routerCalls.push(params);
      return route instanceof Error
        ? Promise.reject(route)
        : Promise.resolve(route);
    }
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

/**
 * A response from a searching turn: the model narrates, searches, and only then
 * emits the JSON. The narration is the trap — joining every text block would
 * hand `JSON.parse` a sentence glued to an object.
 */
const searchedReply = (text: string): Anthropic.Message =>
  ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: BOARD_AGENT_MODEL,
    stop_reason: "end_turn",
    stop_details: null,
    content: [
      { type: "text", text: "I'll look up the weather in Oslo.", citations: null },
      {
        type: "server_tool_use",
        id: "srvtoolu_test",
        name: "web_search",
        input: { query: "oslo weather" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_test",
        content: [
          {
            type: "web_search_result",
            url: "https://example.test/oslo",
            title: "Oslo weather",
            encrypted_content: "ENCRYPTED",
            page_age: null,
          },
        ],
      },
      { type: "text", text, citations: null },
    ],
  }) as unknown as Anthropic.Message;

/** A turn the server paused mid-search. There is no JSON in it yet. */
const paused = (): Anthropic.Message =>
  ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: BOARD_AGENT_MODEL,
    stop_reason: "pause_turn",
    stop_details: null,
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_paused",
        name: "web_search",
        input: { query: "oslo weather" },
      },
    ],
  }) as unknown as Anthropic.Message;

const lastUserText = (
  params: Anthropic.MessageCreateParamsNonStreaming
): string => {
  const last = params.messages[params.messages.length - 1]!;
  return typeof last.content === "string" ? last.content : "";
};

/** Assistant turns are echoed back as content blocks, not as a flat string. */
const assistantText = (message: Anthropic.MessageParam): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
        .map((block) => block.text)
        .join("");

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

  it.effect("offers web search, capped, and does not declare its own code execution", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply(VALID)]);
      yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });

      const tools = recorded.calls[0]!.tools ?? [];
      expect(tools).toEqual(BOARD_AGENT_TOOLS);
      expect(tools).toHaveLength(1);
      const search = tools[0] as Anthropic.WebSearchTool20260318;
      expect(search.type).toBe("web_search_20260318");
      // One search is what a board needs, and a cap of 1 is only *safe* with
      // dynamic filtering off — with it on, the single use is spent inside the
      // code path and the model declares the tool offline.
      expect(search.max_uses).toBe(1);
      expect(search.allowed_callers).toEqual(["direct"]);
      // Nothing here needs code execution, and a second execution environment
      // only confuses the model about which to call.
      expect(
        tools.some((tool) => tool.type?.startsWith("code_execution") ?? false)
      ).toBe(false);
    })
  );

  it("tells the searching prompt to search once, and never sends a dead instruction", () => {
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("search the web for it first");
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("One search");
    // The no-tool prompt must not tell the model to search: starve a search it
    // was told to make and it writes LIVE FEED UNAVAILABLE onto the board.
    expect(BOARD_AGENT_SYSTEM_PROMPT_NO_SEARCH).not.toContain("search the web");
    expect(BOARD_AGENT_SYSTEM_PROMPT_NO_SEARCH).toContain(
      "cannot look anything up"
    );
    // And it must still forbid the thing the feature exists to prevent.
    expect(BOARD_AGENT_SYSTEM_PROMPT_NO_SEARCH).toContain(
      "Never state a number as fact"
    );
  });

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

/**
 * The router exists so the do-not-search rule is a property of the request rather
 * than a line in a prompt the model may ignore — with the tool attached, five of
 * six plain prompts searched anyway. So the assertion that matters is the
 * *absence* of `tools`, not a prompt string.
 */
describe("BoardAgent routing", () => {
  it.effect("asks the cheap model first, and asks it only once", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply(VALID)], routed(true));
      yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });

      expect(recorded.routerCalls).toHaveLength(1);
      const route = recorded.routerCalls[0]!;
      expect(route.model).toBe(BOARD_ROUTER_MODEL);
      expect(route.model).not.toBe(BOARD_AGENT_MODEL);
      // The board is still written by the capable model — routing picks the
      // request shape, not the author.
      expect(recorded.calls[0]!.model).toBe(BOARD_AGENT_MODEL);
      // Haiku 4.5 rejects `effort` with a 400.
      expect(route.output_config?.effort).toBeUndefined();
      // The router must not be handed the search tool either.
      expect(route.tools).toBeUndefined();
    })
  );

  it.effect("withholds the search tool entirely when no live data is needed", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply(VALID)], routed(false));
      yield* makeBoardAgent(client).generate({
        prompt: "remind everyone bin day is thursday",
        current: blankGrid(),
      });

      const board = recorded.calls[0]!;
      // Absent, not empty: a request with no tool *cannot* search, cannot spend
      // the time, and cannot bill a search.
      expect(board.tools).toBeUndefined();
      expect(board.system).toBe(BOARD_AGENT_SYSTEM_PROMPT_NO_SEARCH);
    })
  );

  it.effect("attaches the tool and the searching prompt when live data is needed", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply(VALID)], routed(true));
      yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });

      const board = recorded.calls[0]!;
      expect(board.tools).toEqual(BOARD_AGENT_TOOLS);
      expect(board.system).toBe(BOARD_AGENT_SYSTEM_PROMPT);
    })
  );

  /**
   * The two ways to be wrong are not symmetric: routing a plain board to the
   * searching path costs seconds, routing a weather board to the plain path costs
   * the feature. So every unhappy router path must fail *open*.
   */
  it.effect("falls back to searching when the router call throws", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient(
        [reply(VALID)],
        new Error("503 overloaded_error")
      );
      const result = yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });

      expect(recorded.calls[0]!.tools).toEqual(BOARD_AGENT_TOOLS);
      // A router outage must not fail the board.
      expect(result.attempts).toBe(1);
      expect(result.repaired).toBe(false);
    })
  );

  it.effect("falls back to searching when the router returns unusable JSON", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient(
        [reply(VALID)],
        reply("I think it probably does need a search?")
      );
      yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });
      expect(recorded.calls[0]!.tools).toEqual(BOARD_AGENT_TOOLS);
    })
  );

  it.effect("falls back to searching when the router answers with the wrong type", () =>
    Effect.gen(function* () {
      // Valid JSON, wrong shape — `"yes"` is not a boolean, and coercing it would
      // silently make every malformed answer mean "search".
      const { client, recorded } = stubClient(
        [reply(VALID)],
        reply(JSON.stringify({ needs_live_data: "yes" }))
      );
      yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });
      expect(recorded.calls[0]!.tools).toEqual(BOARD_AGENT_TOOLS);
    })
  );

  it.effect("falls back to searching when the router itself refuses", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([reply(VALID)], refusal("cyber"));
      const result = yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });
      // A refusal from the *router* is not a refusal of the board.
      expect(recorded.calls[0]!.tools).toEqual(BOARD_AGENT_TOOLS);
      expect(result.attempts).toBe(1);
    })
  );

  it.effect("routes once per generate, not once per retry", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient(
        [reply("not json"), reply(VALID)],
        routed(false)
      );
      yield* makeBoardAgent(client).generate({
        prompt: "remind everyone bin day is thursday",
        current: blankGrid(),
      });

      expect(recorded.routerCalls).toHaveLength(1);
      expect(recorded.calls).toHaveLength(2);
      // The retry keeps the route it was given — re-deciding mid-conversation
      // would change the tool set under a cached prefix.
      expect(recorded.calls[1]!.tools).toBeUndefined();
      expect(recorded.calls[1]!.system).toBe(BOARD_AGENT_SYSTEM_PROMPT_NO_SEARCH);
    })
  );
});

describe("BoardAgent with web search", () => {
  it.effect("reads the JSON that follows the search, not the narration before it", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([searchedReply(VALID)]);
      const result = yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });

      // One call: the narration is not a decode failure, so nothing is retried.
      expect(recorded.calls).toHaveLength(1);
      expect(result.attempts).toBe(1);
      expect(result.repaired).toBe(false);
      expect(result.grid.rows[0]!.map((c) => c.char).join("")).toContain(
        "GOOD MORNING"
      );
    })
  );

  it.effect("echoes the search results back on a retry instead of searching again", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([
        searchedReply("not json at all"),
        reply(VALID),
      ]);
      yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });

      const echoed = recorded.calls[1]!.messages[1]!;
      expect(echoed.role).toBe("assistant");
      expect(Array.isArray(echoed.content)).toBe(true);
      const blocks = echoed.content as Anthropic.ContentBlockParam[];
      // The result block must go back verbatim — the API decrypts
      // `encrypted_content` to restore what was found, and a missing or edited
      // one is a 400.
      const searchResult = blocks.find(
        (block) => block.type === "web_search_tool_result"
      ) as { content: Array<{ encrypted_content: string }> } | undefined;
      expect(searchResult?.content[0]!.encrypted_content).toBe("ENCRYPTED");
      expect(blocks.some((block) => block.type === "server_tool_use")).toBe(true);
    })
  );

  it.effect("continues a paused turn without spending a retry attempt", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([paused(), reply(VALID)]);
      const result = yield* makeBoardAgent(client).generate({
        prompt: "what's the weather in oslo",
        current: blankGrid(),
      });

      expect(recorded.calls).toHaveLength(2);
      // The model made no mistake, so this is not attempt 2.
      expect(result.attempts).toBe(1);
      expect(result.repaired).toBe(false);

      // The paused turn goes back unchanged, with nothing appended after it —
      // a correction here would be answering a question the model never asked.
      const resumed = recorded.calls[1]!.messages;
      expect(resumed).toHaveLength(2);
      expect(resumed[1]!.role).toBe("assistant");
    })
  );

  it.effect("gives up on a turn that never stops pausing", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient([paused()]);
      const exit = yield* Effect.exit(
        makeBoardAgent(client).generate({
          prompt: "what's the weather in oslo",
          current: blankGrid(),
        })
      );

      const error = failureOf(exit);
      expect(error._tag).toBe("BoardGenerationError");
      expect(error).toMatchObject({ stage: "empty" });
      expect(recorded.calls).toHaveLength(BOARD_AGENT_MAX_PAUSES + 1);
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
      expect(assistantText(retry.messages[1]!)).toContain("nope");

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

  /**
   * `BoardAgentLive` is a member of the merged `baseLayer`, so every member is
   * constructed when the request runtime is built. A constructor that threw would
   * therefore be a layer-construction *defect* and 500 **every** request in the
   * app — the exact outage a missing R2 binding already caused once. So the
   * throw has to degrade to the same typed, one-procedure failure a missing key
   * produces.
   */
  it.effect("survives a throwing SDK constructor: the layer builds, only generate fails, and it fails typed", () =>
    Effect.gen(function* () {
      const agent = yield* BoardAgent;
      // Constructed at all — that is half the assertion.
      expect(typeof agent.generate).toBe("function");
      expect(agent).toBe(unconfiguredBoardAgent);

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
        makeBoardAgentLive(() => {
          throw new Error("the SDK disliked something about this key");
        }).pipe(
          Layer.provide(
            CloudflareEnvLive({
              ANTHROPIC_API_KEY: "sk-ant-test",
            } as unknown as Env)
          )
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
