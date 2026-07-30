import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { BoardColor } from "@/lib/schemas/board";
import { TILE_COLORS } from "@/components/board/flap-tile";
import { MASK_FILL as BOARD_MASK_FILL } from "@/components/board/board-frame";

/**
 * The controller's shared chrome — the phone half of the split-flap object.
 *
 * The TV display is a piece of painted aluminium with recessed windows punched
 * through it (`board-frame.tsx`, `flap-tile.tsx`). The phone has to read as the
 * *same* object's control panel, so it borrows that object's rules rather than
 * the app's light/dark theme:
 *
 * - **Tonal steps, not shadows.** `#000` field → `#151515` panel → `#222226`
 *   recessed track, each separated by a 1px hairline and a single-pixel top
 *   highlight. Exactly the trick `board-frame` uses for its extrusion lip, and
 *   the reason nothing here needs a blur.
 * - **Tight radii.** 0px on panels and buttons, 2px on wells and flaps —
 *   `flap-tile` derives ~2px for a real card, so a pill would be a lie.
 * - **Condensed uppercase for labels.** No condensed face ships with the app, so
 *   the register is reached with uppercase + wide tracking at small sizes, which
 *   is also what the etched wordmark on the bezel does.
 * - **Literal values, not theme tokens.** The board's palette is *data*: a red
 *   flap is red on a TV in a lit room whatever the app's theme is. The display
 *   route does the same, so the two surfaces cannot drift apart.
 *
 * A phone controller is used standing in a living room, often with the lights
 * down next to a dim TV. That makes the dark field functional, not decorative —
 * a white form here is a flashbang aimed at the person holding it.
 */

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/** The console's tonal ladder. Values, not tokens — see the note above. */
export const CONSOLE = {
  /** Page field. The board's own surround. */
  field: "#000000",
  /** Raised panel: a plate screwed to the field. */
  panel: "#151515",
  /** Recessed track: segmented controls, readouts, chips. */
  track: "#222226",
  /** The bottom of a hole — input wells and flap windows. */
  well: "#0e0e10",
  /** 1px separator. A step above `track` so it reads on both neighbours. */
  hairline: "#2b2b2e",
  /** Primary text. Off-white, never #fff — nothing printed is ever pure. */
  ink: "#eeeef2",
  /** Secondary text and placeholder. */
  inkDim: "#b4b4b8",
  /** Labels, units, inactive icons. */
  inkMute: "#6a6a6c",
  /** State signal only. Never an action fill. */
  amber: "#ffcc00",
} as const;

/**
 * The lip of a raised plate: light along the top edge, dark underneath. Both
 * layers blur-free, so this costs a fill rather than a convolution — the same
 * economy `flap-tile`'s `WELL_SHADOW` is built on.
 */
export const PLATE_LIP =
  "inset 0 1px 0 rgba(255,255,255,0.05), inset 0 0 0 1px rgba(255,255,255,0.045)";

/** The inverse: a hole, shaded at the top lip and lit along the bottom. */
export const WELL_LIP =
  "inset 0 1px 2px rgba(0,0,0,0.75), inset 0 0 0 1px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.045)";

/**
 * Board pigments, copied **verbatim** from `flap-tile.tsx`'s `TILE_COLORS`.
 *
 * Duplicated rather than imported because that module keeps them private and is
 * owned elsewhere this phase. They must stay byte-identical: the preview and the
 * swatches exist to promise what the TV will do, and a pigment that is 3 points
 * off here is a promise the board does not keep.
 *
 * Note `white` and `black` share a fill. That is not a bug and not a shortcut —
 * on the real object `white` is *a white glyph on an unlit flap* and `black` is
 * *an unlit flap*. Which is exactly why neither can be drawn as a coloured
 * circle; see `FlapSwatch`.
 */
/**
 * Re-exported from the TV's own tile, not copied. These were byte-identical
 * duplicates for a while, which meant retuning the board's palette would have
 * silently desynced the phone's preview — the one place the two surfaces must
 * agree exactly, since the preview's whole job is to predict the board.
 */
export const TILE_PIGMENTS = TILE_COLORS;

/**
 * The mask the flaps sit in — the real gradient from `board-frame.tsx`, for the
 * same reason as the pigments above. Neutral grey and deliberately shallow: a
 * steeper ramp would let the bottom row's mask get as dark as an unlit flap and
 * the lattice would vanish.
 */
export const MASK_FILL = BOARD_MASK_FILL;

/** The aluminium extrusion around the mask. */
export const EXTRUSION_FILL = "#414145";
export const EXTRUSION_LIP =
  "inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.7)";

/**
 * A flap's vertical luminance profile, condensed from `flap-tile`'s
 * `FLAP_SURFACE` to nine stops from twelve.
 *
 * The seam at ~48% is the load-bearing stop — it is what makes a rectangle read
 * as two hinged cards — so it keeps its full contrast. The stops that were
 * dropped are sub-pixel at 14px and cost a paint each, 144 times per keystroke.
 * Multiplicative black alpha, so one string serves all eight pigments.
 */
export const FLAP_SURFACE_MINI =
  "linear-gradient(to bottom," +
  "rgba(0,0,0,0.30) 0%," +
  "rgba(0,0,0,0.09) 7%," +
  "rgba(0,0,0,0.09) 46.4%," +
  "rgba(0,0,0,0.58) 48.8%," +
  "rgba(0,0,0,0.54) 51.6%," +
  "rgba(0,0,0,0.02) 54%," +
  "rgba(0,0,0,0.02) 96%," +
  "rgba(255,255,255,0.07) 98.5%," +
  "rgba(0,0,0,0.24) 100%)";

/** The retaining notch cut into a flap's top edge. */
export const FLAP_NOTCH_MINI =
  "linear-gradient(to right," +
  "rgba(0,0,0,0) 41.5%," +
  "rgba(0,0,0,0.66) 41.5%," +
  "rgba(0,0,0,0.66) 58.5%," +
  "rgba(0,0,0,0) 58.5%)";

/* -------------------------------------------------------------------------- */
/* Chrome                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The dark field a console page sits on.
 *
 * `min-h-dvh` on the content is not enough on its own: `body` is white, so an
 * iOS rubber-band scroll past either end flashes the page background straight
 * into the eyes of someone standing in a dim room. A fixed backdrop pinned to
 * the viewport is what actually covers that.
 *
 * `className="dark"` is load-bearing too. The app's dark variant is
 * `&:is(.dark *)`, so this makes every shadcn primitive *inside* the field
 * resolve its dark tokens — the Switch, the Spinner, `FormMessage`'s
 * destructive red — without touching `<html>`, which the TV route and the
 * dashboard share.
 */
export function ConsoleField({
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
 * A section label. Sits *outside* the plate it names, the way silkscreen sits on
 * the panel next to the control rather than on the control.
 */
export function ConsoleLabel({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <h2
      className={cn(
        "flex items-center gap-2 px-1 text-[10px] leading-none font-medium uppercase",
        className
      )}
      style={{ color: CONSOLE.inkMute, letterSpacing: "0.2em" }}
    >
      {children}
    </h2>
  );
}

/** A plate screwed to the field. Square corners, hairline edge, no shadow. */
export function ConsolePlate({
  children,
  className,
  ...rest
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-none", className)}
      style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * A recessed digital readout — revision numbers, counts, units. Mono, because
 * this is the one place a fixed advance is right: the number changes under the
 * user's thumb and must not shuffle the glyphs beside it.
 */
export function ConsoleReadout({
  label,
  value,
  className,
}: {
  readonly label?: string;
  readonly value: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-baseline gap-1 px-1.5 py-0.5 font-mono text-[11px] leading-none",
        className
      )}
      style={{
        backgroundColor: CONSOLE.track,
        boxShadow: "inset 0 1px 0 rgba(0,0,0,0.5)",
        color: CONSOLE.inkDim,
      }}
    >
      {label !== undefined && (
        <span
          className="text-[9px] uppercase"
          style={{ color: CONSOLE.inkMute, letterSpacing: "0.14em" }}
        >
          {label}
        </span>
      )}
      <span style={{ color: CONSOLE.ink }}>{value}</span>
    </span>
  );
}

/**
 * A group of mutually exclusive controls, drawn as one recessed track with the
 * active option raised out of it. One track rather than N outlined buttons: the
 * outlined-button row was the single biggest reason the old controller read as a
 * web form, and a track also makes "one of these is on" legible at a glance
 * without relying on colour.
 */
export function SegmentTrack({
  children,
  className,
  ...rest
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-stretch gap-px p-px", className)}
      style={{
        backgroundColor: CONSOLE.track,
        boxShadow: "inset 0 1px 0 rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.4)",
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Classes for one segment of a `SegmentTrack`. Off-white fill when active. */
export const segmentClass = (active: boolean): string =>
  cn(
    "flex items-center justify-center rounded-none text-[10px] font-medium uppercase",
    "transition-colors select-none disabled:opacity-40",
    active ? "" : "active:brightness-125"
  );

/**
 * `off` is for a track whose whole group is disabled by another control — the
 * pack selector while the board is muted. The selection still has to be visible
 * (it is what the board will use when sound comes back), but an off-white plate
 * at 45% opacity reads as a muddy grey *button*, not as a control that is off. So
 * the active segment loses its fill and keeps only a hairline: still obviously
 * the chosen one, no longer the loudest thing on the panel.
 */
export const segmentStyle = (
  active: boolean,
  off = false
): React.CSSProperties => {
  if (!active) {
    return {
      backgroundColor: "transparent",
      color: off ? CONSOLE.inkMute : CONSOLE.inkDim,
      letterSpacing: "0.14em",
    };
  }
  return off
    ? {
        backgroundColor: "transparent",
        color: CONSOLE.inkDim,
        letterSpacing: "0.14em",
        boxShadow: `inset 0 0 0 1px ${CONSOLE.inkMute}`,
      }
    : {
        backgroundColor: CONSOLE.ink,
        color: CONSOLE.panel,
        letterSpacing: "0.14em",
        boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.25)",
      };
};

/* -------------------------------------------------------------------------- */
/* The swatch — the white-vs-black problem                                    */
/* -------------------------------------------------------------------------- */

/**
 * The sample glyph a swatch shows. `A` because it is the widest-looking letter
 * in the board's charset at small sizes and it is language-neutral: the board
 * only has flaps for `A–Z`, so this is not translatable copy.
 */
const SWATCH_GLYPH = "A";

/**
 * One colour choice, drawn as a **miniature flap in its window**.
 *
 * The defect this fixes: as circles of `fill`, `white` and `black` were two
 * identical black dots, because on this board they *are* the same fill. The
 * difference between them is not pigment, it is whether a glyph is printed on
 * the card — `white` is a white letter on an unlit flap, `black` is an unlit
 * flap with nothing on it.
 *
 * So the swatch stops being a colour sample and becomes an outcome sample: it
 * shows the tile the board will actually produce. `white` shows a light `A`,
 * `black` shows an empty card, and the seven pigments show `A` in their own ink.
 * Nothing has to be learned or read to tell them apart, and the selected
 * colour's name is also spelled out in the row's readout as a second signal.
 */
export function FlapSwatch({
  color,
  active,
}: {
  readonly color: BoardColor;
  readonly active: boolean;
}) {
  const pigment = TILE_PIGMENTS[color];
  return (
    <span
      aria-hidden
      className="relative block h-8 w-full"
      style={{
        backgroundColor: CONSOLE.well,
        borderRadius: "2px",
        // Selected is an off-white ring *inside* the window, so selection reads
        // as the window lighting up rather than as a halo around a dot — and it
        // stays legible on a yellow chip and an unlit one alike.
        boxShadow: active
          ? `inset 0 0 0 2px ${CONSOLE.ink}`
          : "inset 0 0 0 1px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.045)",
      }}
    >
      <span
        className="absolute flex items-center justify-center overflow-hidden font-sans text-[13px] leading-none font-semibold"
        style={{
          top: "8%",
          bottom: "20%",
          left: "14%",
          right: "14%",
          borderRadius: "1px",
          backgroundColor: pigment.fill,
          backgroundImage: `${FLAP_NOTCH_MINI}, ${FLAP_SURFACE_MINI}`,
          backgroundSize: "100% 11%, 100% 100%",
          backgroundPosition: "50% 0, 0 0",
          backgroundRepeat: "no-repeat, no-repeat",
          color: pigment.ink,
        }}
      >
        <span className="block" style={{ transform: "scaleX(0.85)" }}>
          {color === "black" ? "" : SWATCH_GLYPH}
        </span>
      </span>
    </span>
  );
}
