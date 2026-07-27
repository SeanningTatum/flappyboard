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
 * actually want back.
 */
export const BOARD_AGENT_MAX_TOKENS = 4096;

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
 *
 * Colour choice is then a semantic instruction rather than a palette: a
 * temperature coloured by how cold it is carries information, a temperature
 * coloured at random is decoration.
 */
export const BOARD_AGENT_SYSTEM_PROMPT = [
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
  "Be brief and have some personality. Vary the wording, colours and layout each time — never fall back on the same template.",
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

const textOf = (message: Anthropic.Message): string =>
  message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

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

const callModel = (client: BoardAgentClient, messages: Anthropic.MessageParam[]) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        client({
          model: BOARD_AGENT_MODEL,
          max_tokens: BOARD_AGENT_MAX_TOKENS,
          system: BOARD_AGENT_SYSTEM_PROMPT,
          messages,
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
    return text;
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
  messages: Anthropic.MessageParam[],
  attempt: number
): Effect.Effect<
  BoardAgentResult,
  BoardGenerationError | LlmRefusedError
> =>
  Effect.gen(function* () {
    const text = yield* callModel(client, messages);
    const verdict = yield* evaluate(text);

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
      [
        ...messages,
        { role: "assistant", content: text },
        { role: "user", content: retryTurn(verdict.left.error) },
      ],
      attempt + 1
    );
  });

export const makeBoardAgent = (client: BoardAgentClient): BoardAgentShape => ({
  generate: (params) =>
    runPipeline(
      client,
      [{ role: "user", content: firstUserTurn(params.prompt, params.current) }],
      1
    ),
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
 * The key comes off the `CloudflareEnv` Tag, consumed while this Layer is built —
 * never `process.env`, and never read at request time. `CloudflareEnv` therefore
 * stays out of `AppServices` (`runtime.ts` provides it with `Layer.provide`, not
 * `provideMerge`), so this adds no new capability to procedures: the secret is
 * captured in the closure of one service and nothing else can reach it.
 */
export const BoardAgentLive = Layer.effect(
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
    const anthropic = new Anthropic({ apiKey });
    return makeBoardAgent((params) => anthropic.messages.create(params));
  })
);
