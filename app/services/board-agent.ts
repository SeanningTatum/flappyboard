import Anthropic from "@anthropic-ai/sdk";
import { Context, Effect, Either, Layer } from "effect";
import { CloudflareEnv } from "./cloudflare";
import { ConfigurationError } from "@/models/errors/repository";
import {
  BoardGenerationError,
  LlmRefusedError,
} from "@/models/errors/board";
import { compileMessage } from "@/lib/board/compile";
import { decodeOrRepair } from "@/lib/board/repair";
import {
  BLANK_COLOR,
  BOARD_ALIGNS,
  BOARD_CHARS,
  BOARD_COLORS,
  BOARD_COLS,
  BOARD_ROWS,
  decodeBoardMessage,
  decodeRouterDecision,
  type BoardGrid,
  type BoardMessage,
} from "@/lib/schemas/board";

/* -------------------------------------------------------------------------- */
/* Model configuration                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Bare alias, no date suffix — pinning a dated snapshot here would silently rot.
 * Sonnet over Opus is a deliberate product decision: the output is ~150 tokens of
 * schema-constrained JSON, and the phone is waiting on it.
 */
export const BOARD_AGENT_MODEL = "claude-sonnet-5";

/**
 * Thinking is on by default on this model and `max_tokens` caps thinking *plus*
 * response text, so this is generous relative to the ~200 tokens of JSON we
 * actually want back. Doubled from 4096 when web search landed: a searching turn
 * emits `server_tool_use` and result blocks into the *output* alongside the JSON,
 * and a truncation here costs a whole repair cycle.
 */
export const BOARD_AGENT_MAX_TOKENS = 8192;

/**
 * Web search, so "what's the weather" puts today's weather on the board instead
 * of the model's training-cutoff guess.
 *
 * **`allowed_callers: ["direct"]` deliberately turns dynamic filtering off**, and
 * the reason is measured, not assumed. Left on its default the tool runs the
 * search from inside code execution and filters results before they reach the
 * context window — which saves tokens and costs a great deal of wall clock,
 * because the code-execution leg is serial and the phone is waiting on it. Direct
 * search on the same prompt: **14.5s and ~14k input tokens** against **30–35s** for
 * the filtered path. Filtering optimises the wrong resource for this feature.
 *
 * Turning it off is also what makes `max_uses: 1` viable. A cap of 1 *with*
 * filtering does not bound the search, it starves it: the single use is spent
 * inside the code path and the model concludes the tool is broken, writing
 * `LIVE FEED UNAVAILABLE / SEARCH TOOL OFFLINE` onto the board. Measured twice,
 * at 73s and 41s. One direct search is what a board actually needs — one subject,
 * one fact — and it bounds the bill, since search bills per use on top of tokens.
 *
 * Do **not** add `code_execution` here. Nothing in this configuration needs it,
 * and a second execution environment only confuses the model about which to call.
 */
export const BOARD_AGENT_TOOLS: Anthropic.ToolUnion[] = [
  {
    type: "web_search_20260318",
    name: "web_search",
    max_uses: 1,
    allowed_callers: ["direct"],
  },
];

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Haiku decides one thing: does this request depend on information the model
 * cannot already know?
 *
 * The point is **not** to run the board on a cheaper model — that was measured and
 * buys nothing. Haiku wrote a board in 16.5s against Sonnet's 14.5s, because the
 * wall clock is dominated by the search round trip rather than by model tier, and
 * Haiku's layout was visibly worse (blank rows where Sonnet uses `spread`).
 *
 * The point is to decide **whether to attach the search tool at all**. That turns
 * the do-not-search rule from a line in the prompt into a property of the request:
 * a plain board physically cannot search, so it cannot spend the time or the money
 * or invent a figure. The prompt alone does not hold — with direct search enabled,
 * five of six plain prompts searched anyway, taking a reminder from ~3s to ~9s and
 * billing a search for it.
 *
 * Haiku 4.5 is the router because it is the cheapest model that supports
 * structured outputs, and one boolean is exactly the shape of work it is good at.
 * Note it rejects `output_config.effort` with a 400 and has no adaptive thinking,
 * so neither is sent.
 */
export const BOARD_ROUTER_MODEL = "claude-haiku-4-5";

/** One boolean of JSON. The cap is generous purely so a stray token cannot truncate it. */
export const BOARD_ROUTER_MAX_TOKENS = 256;

export const BOARD_ROUTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["needs_live_data"],
  properties: {
    needs_live_data: {
      type: "boolean",
      description:
        "True if answering needs current real-world information the model cannot already know — weather, forecast, score, price, departure time, exchange rate, today's news. False for anything self-contained: greetings, reminders, jokes, countdowns, announcements, or edits to the board's current text.",
    },
  },
};

export const BOARD_ROUTER_SYSTEM_PROMPT = [
  "You route one request and return only JSON.",
  "",
  "Decide whether writing this message needs current real-world information that you could not already know — weather, a forecast, a score, a price, a departure time, an exchange rate, today's news.",
  "",
  'Answer false when the request is self-contained: a greeting, a reminder ("bin day is Thursday"), a joke, a countdown, an announcement, or an edit to what is already on the board. A date or a day of the week that the request itself supplies is not live data.',
  "",
  "Answer true only if a figure or fact would have to be looked up to be correct.",
].join("\n");

/**
 * Server tools run in a loop on Anthropic's side, and a long one comes back as
 * `stop_reason: "pause_turn"` rather than a finished answer. Continuing is just
 * re-sending the paused turn, so the cap is only a runaway guard — the search
 * budget above is the real bound.
 */
export const BOARD_AGENT_MAX_PAUSES = 3;

/**
 * `low` effort, because the hard part of this task is obeying a 6×24 grid and a
 * fixed charset — not reasoning. Deep deliberation buys nothing here and the
 * user is watching a blank TV while it runs.
 *
 * Note what is **absent**: `temperature` and `top_p`. This model rejects both
 * with a 400. Variety between generations comes from the system prompt asking
 * for it, not from a sampling knob.
 */
const BOARD_AGENT_EFFORT = "low" as const;

/** One initial call plus at most two repair-informed retries. */
export const BOARD_AGENT_MAX_ATTEMPTS = 3;

/* -------------------------------------------------------------------------- */
/* Prompting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Short on purpose. The constraints that actually decide whether a board reads
 * well are the grid size, the charset, and the fact that colour is per-segment —
 * a wall of instructions measurably makes the copy worse.
 *
 * Four affordances are non-obvious enough that the model never finds them on its
 * own, and each costs a line:
 *
 * - **The grid.** 6 × 24 stated as a *canvas* rather than a line length. Told only
 *   "24 characters per row" the model writes six sentences; told "144 tiles, each
 *   one a character or a solid colour" it will frame a headline. The full-width bar
 *   is spelled out as an explicit worked example because it is the one shape people
 *   actually ask for, and because a 24-space segment is not a thing a model guesses.
 * - **The all-space segment.** Without being told, it never discovers it can draw
 *   solid blocks, so every board comes back as plain white text. Paired with a
 *   restraint line — an unasked-for frame on `BIN DAY IS THURSDAY` is worse than no
 *   frame at all — because "you can draw" reads as "always draw". The *scope* of
 *   the rule is stated too, because the model writes `{ "HAPPY FRIDAY!", green }`
 *   meaning green letters: `compile.ts` lights a coloured space only in a segment
 *   made entirely of spaces, and saying so is cheaper than letting the model guess.
 * - **`align: "spread"`.** Label left, value flush right, on one row. This used to
 *   be phrased as "several segments plus a gap you count out to 24" — and the model
 *   cannot count to 24 in a charset where `12°` is three cells, so it padded rows
 *   by eye: sometimes flush, usually a few columns short, and occasionally long
 *   enough to wrap the value onto the next row. Now the alignment does the
 *   arithmetic, and the prompt's job is only to name it and to *forbid* the manual
 *   padding it replaces.
 * - **Naming the subject.** Asked for the weather in Oslo it writes `TODAY'S
 *   OUTLOOK`, because nothing told it the board is read by someone who cannot see
 *   the prompt. A board about a named thing should say which thing.
 * - **Searching.** The model decides on its own whether a request needs the web,
 *   and left alone it under-reaches: asked for the weather it will happily invent
 *   a plausible temperature, which is the one failure mode a board makes look
 *   authoritative. So the trigger condition is stated, and paired with its
 *   opposite — a board is six rows, and a model that searches before writing
 *   `HAPPY BIRTHDAY MUM` has spent ten seconds and two searches on nothing.
 *
 * Colour choice is then a semantic instruction rather than a palette: a
 * temperature coloured by how cold it is carries information, a temperature
 * coloured at random is decoration.
 */
const BOARD_AGENT_PROMPT_BODY = [
  `You compose on a physical split-flap board: a grid of ${BOARD_ROWS} rows × ${BOARD_COLS} columns, ${
    BOARD_ROWS * BOARD_COLS
  } tiles. Every tile shows either one character or one solid colour. You are laying out a grid, not writing lines of text.`,
  "",
  "TEXT",
  `- ${BOARD_COLS} columns per row, ${BOARD_ROWS} rows. Rows longer than ${BOARD_COLS} wrap, and anything past row ${BOARD_ROWS} is cut — so keep each row short.`,
  `- UPPERCASE ONLY. The only characters a flap can show are: ${BOARD_CHARS.trim()} and space. No lowercase, no emoji, no accents.`,
  `- Colour is per segment, not per row. One row can mix segments of different colours. Legal colours: ${BOARD_COLORS.join(", ")}.`,
  `- align is one of ${BOARD_ALIGNS.join(", ")}. NEVER pad with spaces to position text — align does it for you, exactly.`,
  `- A label and its value go on ONE row with "align": "spread": { "align": "spread", "segments": [{ "text": "RAIN", "color": "white" }, { "text": "30%", "color": "orange" }] }. Spread puts the first segment against the left edge, the last against the right edge, and spaces any middle ones evenly. Never put a label on one row and its value on the next.`,
  "- Colour means something: cold blue, hot red, good or on time green, delay or warning orange or yellow. Labels stay white.",
  "- If the request names a subject — a city, a team, a person, a route — name it on the board, usually as the top row. OSLO WEATHER, not TODAY'S OUTLOOK.",
  "- Blank rows are real layout. Use them to breathe. Centre short messages.",
  "",
  "DRAWING",
  `- "${BLANK_COLOR}" is the unlit tile — the background. Never put text in it.`,
  `- A segment of NOTHING BUT SPACES in any colour except white and ${BLANK_COLOR} is a run of lit tiles. ${BOARD_COLS} of them fill a whole row as a solid bar; fewer make blocks, gutters and margins.`,
  "- On a segment that has letters in it, the colour is the colour of the letters: the gaps between its words stay unlit, exactly as they would in white. To light a gap, make it its own all-spaces segment.",
  `- A frame is a full-width bar on row 1 and another on row ${BOARD_ROWS} — the first and last rows, so the frame spans the whole board — with the text and blank rows between. A full-width bar is ONE segment of ${BOARD_COLS} spaces: { "align": "left", "segments": [{ "text": "${" ".repeat(
    BOARD_COLS
  )}", "color": "violet" }] }`,
  `- Side borders work too but cost columns: a coloured space at each end of a row leaves ${
    BOARD_COLS - 2
  } for the text.`,
  "- Decorate only when the request asks for a look, or when a headline is helped by a frame. A plain message stays plain — no gratuitous borders.",
  "",
].join("\n");

const BOARD_AGENT_PROMPT_TAIL =
  "\nBe brief and have some personality. Vary the wording, colours and layout each time — never fall back on the same template.";

/**
 * The prompt sent when the request was routed as needing live data, so the search
 * tool is actually attached. Telling the model to search is only honest here.
 */
export const BOARD_AGENT_SYSTEM_PROMPT = [
  BOARD_AGENT_PROMPT_BODY,
  "FACTS",
  "- If the board depends on something current — weather, a forecast, a score, a price, a departure time, today's news — search the web for it first and put the real number on the board. Never invent one: a split-flap board reads as fact.",
  "- One search. Read what it gives you and write the board; do not go looking for a second opinion.",
  BOARD_AGENT_PROMPT_TAIL,
].join("\n");

/**
 * The prompt sent when the request was routed as *not* needing live data, so no
 * search tool is attached at all.
 *
 * It is a separate prompt rather than the same one, because a request with no
 * tool carrying an instruction to "search the web first" is a lie the model acts
 * on: starve the search and it writes `LIVE FEED UNAVAILABLE / SEARCH TOOL
 * OFFLINE` onto the board — measured, twice. So the no-tool prompt states the
 * constraint instead, which turns the one bad case (a live-data request the
 * router got wrong) into an honest board rather than an invented number. Two
 * variants also means two stable prompt prefixes, both cacheable; a prompt built
 * per request would be neither.
 */
export const BOARD_AGENT_SYSTEM_PROMPT_NO_SEARCH = [
  BOARD_AGENT_PROMPT_BODY,
  "FACTS",
  "- You cannot look anything up on this request. Write the board from what the request already tells you.",
  "- Never state a number as fact that the request did not give you — no temperature, price, score or departure time. A split-flap board reads as fact, so inventing one is worse than leaving it out. If the request needed a figure you were not given, say plainly on the board that it is unavailable.",
  BOARD_AGENT_PROMPT_TAIL,
].join("\n");

/**
 * The JSON Schema handed to structured outputs, so the model's JSON is enforced
 * server-side rather than hoped for. It mirrors `BoardMessage` — the two are
 * views of one contract, and `decodeBoardMessage` remains the authority.
 *
 * **Deliberately carries no size bounds.** Structured outputs reject them:
 * `maxItems` on an array is a hard 400 (`For 'array' type, property 'maxItems'
 * is not supported`), as are `maxLength` and the numeric constraints. So the row
 * and segment counts live in the `description` fields and the prompt, and the
 * *enforcement* is `decodeBoardMessage` → retry → `decodeOrRepair` →
 * `compileMessage`. Structured outputs buy the shape; the pipeline buys the size.
 *
 * `additionalProperties: false` is required on every object by the dialect and is
 * also what stops the model inventing fields the decoder would reject.
 */
export const BOARD_MESSAGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      description: `Up to ${BOARD_ROWS} rows, top to bottom.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["align", "segments"],
        properties: {
          align: { type: "string", enum: [...BOARD_ALIGNS] },
          segments: {
            type: "array",
            description:
              "Runs of text that share a colour, left to right. Empty for a blank row.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "color"],
              properties: {
                text: {
                  type: "string",
                  description:
                    "Uppercase text, or spaces to draw solid colour tiles.",
                },
                color: { type: "string", enum: [...BOARD_COLORS] },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * The board as it stands right now, rendered for the prompt. This is what makes
 * a follow-up like "make it funnier" work: the model can see what it is editing.
 * Colours are listed per row rather than per cell — enough context to riff on,
 * cheap enough not to crowd out the actual request.
 */
export const renderGridForPrompt = (grid: BoardGrid): string => {
  const lines = grid.rows.map((row) => {
    const text = row.map((cell) => cell.char).join("");
    const colors = [
      ...new Set(
        row.filter((cell) => cell.color !== BLANK_COLOR).map((c) => c.color)
      ),
    ];
    const suffix = colors.length > 0 ? `  [${colors.join(" ")}]` : "";
    return `|${text}|${suffix}`;
  });
  const isBlank = grid.rows.every((row) =>
    row.every((cell) => cell.char === " " && cell.color === BLANK_COLOR)
  );
  return isBlank ? "(the board is currently blank)" : lines.join("\n");
};

const firstUserTurn = (prompt: string, current: BoardGrid): string =>
  [
    "THE BOARD RIGHT NOW:",
    renderGridForPrompt(current),
    "",
    "REQUEST:",
    prompt,
  ].join("\n");

/** Fed back verbatim on a retry so the model repairs *its own* mistake. */
export const retryTurn = (error: string): string =>
  [
    `That did not decode as a board message:`,
    error,
    "",
    `Send corrected JSON. Remember: at most ${BOARD_ROWS} rows, every segment is { text, color } with a legal colour, text uppercase only.`,
  ].join("\n");

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The entire surface of the Anthropic SDK this service touches, as a single
 * function. Narrow on purpose: the unit tests substitute a plain async function
 * returning SDK-shaped payloads, so the refusal check, the text extraction and
 * the whole retry/repair pipeline are exercised without a network call — while
 * still being typed against the real SDK types, so a shape change breaks the
 * build rather than production.
 */
export type BoardAgentClient = (
  params: Anthropic.MessageCreateParamsNonStreaming
) => Promise<Anthropic.Message>;

export interface GenerateBoardParams {
  readonly prompt: string;
  /** The live grid, included as context so follow-up prompts can edit it. */
  readonly current: BoardGrid;
}

export interface BoardAgentResult {
  readonly message: BoardMessage;
  readonly grid: BoardGrid;
  /** `compileMessage`'s flag — drives the "trimmed to fit" hint. */
  readonly truncated: boolean;
  /** True when the model never produced a decodable message and we coerced one. */
  readonly repaired: boolean;
  /** How many model calls it took (1 on the happy path). */
  readonly attempts: number;
}

export interface BoardAgentShape {
  readonly generate: (
    params: GenerateBoardParams
  ) => Effect.Effect<
    BoardAgentResult,
    BoardGenerationError | LlmRefusedError | ConfigurationError
  >;
}

export class BoardAgent extends Context.Tag("app/BoardAgent")<
  BoardAgent,
  BoardAgentShape
>() {}

/** Cap the fed-back decode error so a pathological tree can't blow up the prompt. */
const MAX_FED_BACK_ERROR = 600;

/**
 * The JSON is the **trailing** run of text blocks, not every text block joined.
 *
 * Without search there is only ever one, so the two definitions agree. With
 * search the response is `server_tool_use` / `web_search_tool_result` /
 * `code_execution_tool_result` / … / text, and the model is free to narrate
 * before it searches. Joining everything would then hand `JSON.parse` a
 * sentence glued to an object — a decode failure that reads like a model
 * mistake and costs a retry, for a response that was actually fine.
 */
const textOf = (message: Anthropic.Message): string => {
  // `findLastIndex` would say this in one line, but it needs lib es2023.
  let start = message.content.length;
  while (start > 0 && message.content[start - 1]!.type === "text") start -= 1;
  return message.content
    .slice(start)
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
};

/** JSON.parse throws; `Effect.try` is the only place that's allowed to matter. */
const parseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => `Response was not valid JSON: ${String(cause)}`,
  });

interface Rejected {
  /** What to hand `decodeOrRepair` if we run out of retries. */
  readonly raw: unknown;
  /** What to tell the model it got wrong. */
  readonly error: string;
}

/**
 * Right: a message that satisfies `BoardMessage`. Left: the salvage material plus
 * the reason, so the caller can either retry with the reason or repair the raw.
 *
 * When the text was not even JSON, `raw` is the text itself — `repairMessage`
 * treats a bare string as a single row, which is exactly the "degrade to clipped
 * text" behaviour we want at the end of the line.
 */
const evaluate = (text: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.either(parseJson(text));
    if (Either.isLeft(parsed)) {
      return Either.left<Rejected>({ raw: text, error: parsed.left });
    }
    const decoded = decodeBoardMessage(parsed.right);
    if (Either.isRight(decoded)) {
      return Either.right<BoardMessage>(decoded.right);
    }
    return Either.left<Rejected>({
      raw: parsed.right,
      error: decoded.left.message.slice(0, MAX_FED_BACK_ERROR),
    });
  });

const finish = (
  message: BoardMessage,
  meta: { readonly attempts: number; readonly repaired: boolean }
): BoardAgentResult => {
  const compiled = compileMessage(message);
  return {
    message,
    grid: compiled.grid,
    truncated: compiled.truncated,
    repaired: meta.repaired,
    attempts: meta.attempts,
  };
};

/** What one completed model turn yields: the JSON, and the turn itself to echo. */
interface Turn {
  readonly text: string;
  /**
   * The assistant turn verbatim. Echoed rather than reduced to `text` because
   * search results carry `encrypted_content` that the API decrypts to restore
   * them on later turns — send the blocks back unchanged and a retry still sees
   * what was found; send only the text and the model searches all over again.
   * It also keeps the thinking blocks, which must be replayed unmodified.
   */
  readonly content: Anthropic.ContentBlock[];
}

/**
 * What the router decided, as the two things it changes about the request.
 *
 * `tools` is **omitted entirely** rather than sent empty when the board needs no
 * search: an absent tool is what makes the guardrail structural instead of
 * advisory, and it keeps the request shape identical to the pre-search one.
 */
interface Route {
  readonly system: string;
  readonly tools?: Anthropic.ToolUnion[];
}

export const SEARCHING_ROUTE: Route = {
  system: BOARD_AGENT_SYSTEM_PROMPT,
  tools: BOARD_AGENT_TOOLS,
};

export const PLAIN_ROUTE: Route = {
  system: BOARD_AGENT_SYSTEM_PROMPT_NO_SEARCH,
};

const callModel = (
  client: BoardAgentClient,
  route: Route,
  messages: Anthropic.MessageParam[],
  pauses = 0
): Effect.Effect<Turn, BoardGenerationError | LlmRefusedError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        client({
          model: BOARD_AGENT_MODEL,
          max_tokens: BOARD_AGENT_MAX_TOKENS,
          system: route.system,
          messages,
          ...(route.tools ? { tools: route.tools } : {}),
          output_config: {
            effort: BOARD_AGENT_EFFORT,
            format: {
              type: "json_schema",
              schema: BOARD_MESSAGE_JSON_SCHEMA,
            },
          },
        }),
      catch: (cause) => new BoardGenerationError({ stage: "request", cause }),
    });

    // Checked BEFORE touching `content`: on a refusal the content array is empty
    // (or a discarded partial), so reading it first is how you get `undefined`
    // instead of a diagnosable failure.
    if (response.stop_reason === "refusal") {
      return yield* Effect.fail(
        new LlmRefusedError({
          category: response.stop_details?.category ?? null,
        })
      );
    }

    // A long search turn is paused, not finished: there is no JSON to read yet,
    // and continuing is simply re-sending the paused turn with nothing appended.
    // This is not a retry — the model has made no mistake — so it does not spend
    // an attempt.
    if (response.stop_reason === "pause_turn") {
      if (pauses >= BOARD_AGENT_MAX_PAUSES) {
        return yield* Effect.fail(
          new BoardGenerationError({
            stage: "empty",
            cause: `model paused ${BOARD_AGENT_MAX_PAUSES} times without finishing`,
          })
        );
      }
      yield* Effect.logWarning("Board agent turn paused; continuing").pipe(
        Effect.annotateLogs({ pauses: pauses + 1 })
      );
      return yield* callModel(
        client,
        route,
        [...messages, { role: "assistant", content: response.content }],
        pauses + 1
      );
    }

    const text = textOf(response);
    if (text.length === 0) {
      return yield* Effect.fail(
        new BoardGenerationError({
          stage: "empty",
          cause: `model returned no text (stop_reason: ${String(
            response.stop_reason
          )})`,
        })
      );
    }
    return { text, content: response.content };
  });

/**
 * Call → decode → retry with the decode error → deterministic repair.
 *
 * Written as an explicit recursive loop rather than `Effect.retry` +
 * `Schedule.recurs(2)` on purpose: **each attempt has different input.** The
 * whole point is that the model is shown its own decode error, so the retry is
 * not a re-run of the same effect — the conversation grows by two turns each
 * time. `Effect.retry` gives you no channel to feed a failure forward, so
 * expressing this with a schedule would mean smuggling the error through a `Ref`
 * and rebuilding the request inside the retried effect anyway. The loop makes
 * the growing conversation the loop state, which is both shorter and the thing a
 * reader needs to understand.
 *
 * The exit is total: after `BOARD_AGENT_MAX_ATTEMPTS` the last raw response goes
 * through `decodeOrRepair`, which never fails. So a pathological model response
 * degrades to clipped text on the board — never to a failed request.
 */
const runPipeline = (
  client: BoardAgentClient,
  route: Route,
  messages: Anthropic.MessageParam[],
  attempt: number
): Effect.Effect<
  BoardAgentResult,
  BoardGenerationError | LlmRefusedError
> =>
  Effect.gen(function* () {
    const turn = yield* callModel(client, route, messages);
    const verdict = yield* evaluate(turn.text);

    if (Either.isRight(verdict)) {
      return finish(verdict.right, { attempts: attempt, repaired: false });
    }

    yield* Effect.logWarning("Board agent response did not decode").pipe(
      Effect.annotateLogs({ attempt, error: verdict.left.error })
    );

    if (attempt >= BOARD_AGENT_MAX_ATTEMPTS) {
      const repaired = decodeOrRepair(verdict.left.raw);
      yield* Effect.logWarning("Board agent fell through to repair").pipe(
        Effect.annotateLogs({ attempts: attempt })
      );
      return finish(repaired.message, {
        attempts: attempt,
        repaired: repaired.repaired,
      });
    }

    return yield* runPipeline(
      client,
      route,
      [
        ...messages,
        { role: "assistant", content: turn.content },
        { role: "user", content: retryTurn(verdict.left.error) },
      ],
      attempt + 1
    );
  });

/**
 * Ask Haiku whether this request needs the web, and pick the route.
 *
 * **Never fails, and defaults to searching.** Every unhappy path — network error,
 * refusal, unparseable JSON, a boolean that isn't there — resolves to
 * `SEARCHING_ROUTE`, because the two ways to be wrong are not symmetric. Route a
 * plain board to the searching path and it costs a few seconds and one search.
 * Route a weather board to the plain path and the board either says the figure is
 * unavailable or, worse, the model reaches for one it cannot have — which is the
 * exact failure this whole feature exists to remove. So the cheap mistake is the
 * default and the expensive one has to be earned by an explicit `false`.
 */
export const routeFor = (
  client: BoardAgentClient,
  prompt: string
): Effect.Effect<Route> =>
  Effect.gen(function* () {
    const response = yield* Effect.either(
      Effect.tryPromise({
        try: () =>
          client({
            model: BOARD_ROUTER_MODEL,
            max_tokens: BOARD_ROUTER_MAX_TOKENS,
            system: BOARD_ROUTER_SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
            // No `effort`: Haiku 4.5 rejects it with a 400.
            output_config: {
              format: { type: "json_schema", schema: BOARD_ROUTER_SCHEMA },
            },
          }),
        catch: (cause) => cause,
      })
    );

    if (Either.isLeft(response)) {
      yield* Effect.logWarning(
        "Board router call failed — defaulting to the searching route"
      ).pipe(Effect.annotateLogs({ cause: String(response.left) }));
      return SEARCHING_ROUTE;
    }

    if (response.right.stop_reason === "refusal") {
      yield* Effect.logWarning(
        "Board router refused — defaulting to the searching route"
      );
      return SEARCHING_ROUTE;
    }

    const parsed = yield* Effect.either(parseJson(textOf(response.right)));
    if (Either.isLeft(parsed)) {
      yield* Effect.logWarning(
        "Board router did not return JSON — defaulting to the searching route"
      ).pipe(Effect.annotateLogs({ cause: parsed.left }));
      return SEARCHING_ROUTE;
    }

    // Effect Schema rather than a `typeof` check, so a truthy-but-wrong answer
    // (`"yes"`, `1`) is a decode failure and therefore falls open, instead of
    // being coerced into the expensive branch by accident.
    const decision = decodeRouterDecision(parsed.right);
    if (Either.isLeft(decision)) {
      yield* Effect.logWarning(
        "Board router reply did not decode — defaulting to the searching route"
      ).pipe(Effect.annotateLogs({ cause: decision.left.message }));
      return SEARCHING_ROUTE;
    }

    yield* Effect.logInfo("Board route chosen").pipe(
      Effect.annotateLogs({ needsLiveData: decision.right.needs_live_data })
    );
    return decision.right.needs_live_data ? SEARCHING_ROUTE : PLAIN_ROUTE;
  });

export const makeBoardAgent = (client: BoardAgentClient): BoardAgentShape => ({
  generate: (params) =>
    Effect.gen(function* () {
      const route = yield* routeFor(client, params.prompt);
      return yield* runPipeline(
        client,
        route,
        [{ role: "user", content: firstUserTurn(params.prompt, params.current) }],
        1
      );
    }),
});

/**
 * The shape used when `ANTHROPIC_API_KEY` is absent: constructing succeeds, and
 * only `generate` fails.
 *
 * Why not fail the Layer: every member of a merged layer is built when the
 * runtime is built, so a `ConfigurationError` here would 500 *every* request in
 * the app — the exact failure mode that got `Bucket` evicted from the global
 * runtime (see `runtime.ts` and `.brain/rules/services.md`). But unlike a
 * binding, the key is a secret rather than a `wrangler.jsonc` declaration, so
 * there is no route-local `env` to build it from either. Deferring the typed
 * failure to the call site gets both properties: a deploy with no key serves the
 * whole app and fails exactly one procedure, with the same
 * `ConfigurationError` a fail-fast layer would have raised.
 */
export const unconfiguredBoardAgent: BoardAgentShape = {
  generate: () =>
    Effect.fail(
      new ConfigurationError({
        service: "BoardAgent",
        field: "ANTHROPIC_API_KEY",
      })
    ),
};

/**
 * How a client is built from a key. A named type only so the constructor can be
 * substituted in a test — production has exactly one implementation.
 */
export type AnthropicFactory = (apiKey: string) => {
  readonly messages: { readonly create: BoardAgentClient };
};

const defaultAnthropicFactory: AnthropicFactory = (apiKey) =>
  new Anthropic({ apiKey });

/**
 * The key comes off the `CloudflareEnv` Tag, consumed while this Layer is built —
 * never `process.env`, and never read at request time. `CloudflareEnv` therefore
 * stays out of `AppServices` (`runtime.ts` provides it with `Layer.provide`, not
 * `provideMerge`), so this adds no new capability to procedures: the secret is
 * captured in the closure of one service and nothing else can reach it.
 *
 * **Nothing in here may throw.** `BoardAgentLive` is a member of the merged
 * `baseLayer`, so every member is constructed when the request runtime is built:
 * a bare `new Anthropic({ apiKey })` that threw — a malformed key, an SDK that
 * dislikes something about the runtime — would be a layer-construction *defect*
 * and 500 **every request in the app**, which is precisely the outage this file's
 * docblock claims cannot happen here (and which a missing R2 binding already
 * caused once). So the constructor is wrapped, and a throw degrades to
 * `unconfiguredBoardAgent`: exactly one procedure fails, typed, with the same
 * `ConfigurationError` a missing key produces.
 *
 * `createClient` is a parameter purely so a test can supply a throwing
 * constructor; every production caller uses `BoardAgentLive` below.
 */
export const makeBoardAgentLive = (
  createClient: AnthropicFactory = defaultAnthropicFactory
) =>
  Layer.effect(
    BoardAgent,
    Effect.gen(function* () {
      const env = yield* CloudflareEnv;
      const apiKey = (env as Env & { ANTHROPIC_API_KEY?: string })
        .ANTHROPIC_API_KEY;
      if (!apiKey) {
        yield* Effect.logWarning(
          "ANTHROPIC_API_KEY is not set — board.generate will fail with ConfigurationError"
        );
        return unconfiguredBoardAgent;
      }

      const constructed = yield* Effect.either(
        Effect.try({
          try: () => createClient(apiKey),
          catch: (cause) => cause,
        })
      );
      if (Either.isLeft(constructed)) {
        yield* Effect.logError(
          "Anthropic client could not be constructed — board.generate will fail with ConfigurationError"
        ).pipe(Effect.annotateLogs({ cause: String(constructed.left) }));
        return unconfiguredBoardAgent;
      }

      const anthropic = constructed.right;
      return makeBoardAgent((params) => anthropic.messages.create(params));
    })
  );

export const BoardAgentLive = makeBoardAgentLive();
