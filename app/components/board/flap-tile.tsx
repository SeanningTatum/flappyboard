import { useMemo, useRef, type CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { FLAP_LAND_MS } from "@/lib/board/flap-travel";
import type { BoardColor } from "@/lib/schemas/board";

/**
 * One flap of the board.
 *
 * Constraint that shapes everything here: this runs on a Samsung Tizen TV
 * browser, which is a several-years-old Chromium. So the flip uses **only**
 * `transform`, `opacity` and `transition` — no `@keyframes`, no `:has()`, no
 * container queries, no view transitions, no `@property`.
 *
 * ## Who owns what
 *
 * A real tile does not swap glyphs, it *travels* through them — see
 * `app/lib/board/flap-travel.ts`. A single character change can be 56 flaps over
 * four seconds, and 144 tiles doing that at ~14 flaps/second is up to ~2,000
 * glyph changes a second. React cannot be in that path on a TV, and neither can
 * 144 timers.
 *
 * So this component renders the tile's **structure** and nothing else that
 * moves. The two faces are painted once, from the cell present on the very first
 * render, and then frozen: the vdom for the whole well subtree is memoised on a
 * ref-stable value, so however many times React re-renders the board it never
 * touches a face again. From then on the faces belong to the single
 * `requestAnimationFrame` loop in `board-grid-view.tsx`, which finds them by
 * `data-flap-face` / `data-flap-glyph` and mutates `textContent`, `transform`, `opacity`
 * and the two colour properties directly.
 *
 * React keeps exactly one job here: `data-char` / `data-color` on the tile root,
 * which always state the **target** cell. That is what tests and the
 * accessibility tree read, it is two attribute writes per changed tile per
 * update, and it is deliberately *not* what is on screen mid-travel.
 *
 * The alternative — React owning the glyph — was tried and is wrong in a
 * specific, visible way: on the commit that delivers a new grid, React would
 * write the final text into every face, so the board would flash the answer for
 * one frame before starting to travel towards it.
 *
 * ## The flip primitive
 *
 * Two stacked faces and one boolean, kept from the original design because it is
 * still the right primitive for the beat that matters — the *landing*. The
 * incoming glyph is written into the hidden face and the two are swapped on one
 * `transform`/`opacity` transition, so the outgoing card rotates away as the
 * incoming one rotates in.
 *
 * The intermediate flaps do **not** use it. They are a `textContent` write plus
 * one alternating `rotateX` on the single visible face, with transitions
 * switched off — an instant cut, which is what a split-flap at speed actually
 * looks like, and which costs two style writes per tile per flap instead of
 * restarting 288 CSS transitions ~14 times a second. See
 * `board-grid-view.tsx` for the measurement that settled it.
 *
 * ## Anatomy
 *
 * Measured off Vestaboard's own product photography, zoomed to the pixel
 * (`vb-front.jpg`, columns 540–760). A character position is **not** a coloured
 * rectangle, it is three things stacked in a hole:
 *
 * ```
 *   ┌──────────────┐  ← window: a dark recess punched through the mask,
 *   │ ▓▓▓▓▓▓∨▓▓▓▓▓ │    90% of the column pitch, 70% of the row pitch
 *   │ ▓┌────────┐▓ │  ← notch cut into the flap's top edge
 *   │ ▓│  upper │▓ │  ← the flap, ~80% of the window's width. Its upper half
 *   │ ▓├────────┤▓ │    is ~9% darker than its lower half
 *   │ ▓│  lower │▓ │  ← seam: a genuine dark hairline at the flap's midline
 *   │ ▓└────────┘▓ │
 *   │ ▓▓≡≡≡≡≡≡≡≡▓▓ │  ← the resting stack of cards, seen edge-on. Dark, with
 *   └──────────────┘    ~5 hairlines, and dark regardless of the flap's colour
 * ```
 *
 * The seam lands at ~40% of the window's height, not 50%, precisely because the
 * bottom quarter of the window is stack rather than flap. That was the detail the
 * first two passes got wrong.
 *
 * ## How that is built, cheaply
 *
 * Two elements, three gradients, no per-tile shadow stacks:
 *
 * - The **well** is the window, and its own background is doing real work: the
 *   flap is inset *inside* it, so the well shows through as the recess walls and
 *   the top lip (flat near-black) and as the stack band (its one gradient).
 *   Solid-colour boundaries give crisper mechanical edges than gradient stops
 *   would, for free.
 * - The **faces** are the flap. Two gradients: the notch, and the vertical
 *   luminance profile. Both are colour-independent black/white alpha, so one
 *   string serves all eight pigments and the profile stays *multiplicative* —
 *   "9% darker" is 9% darker on a yellow chip and on an unlit one alike. (An
 *   additive white sheen, which is what the first pass used, blew the unlit flaps
 *   out by 60%.) They live on the face rather than the well so they rotate *with*
 *   the flap, which is also what a real one does.
 *
 * Everything else — the recess lip, the frame — is blur-free `box-shadow`, i.e. a
 * fill rather than a convolution. That matters 144 times over.
 */

/**
 * Rest, hidden, and the two travel attitudes.
 *
 * `TRAVEL_TILT` alternates per flap. It is deliberately only two values: at ~14
 * flaps/second the eye cannot resolve more than "the card is moving", and each
 * extra value would buy nothing while a second style write would cost 144 more
 * DOM touches per flap. −34° with the well's 400px perspective reads as the top
 * edge of the card swinging towards the viewer, which is the direction a real
 * flap falls.
 */
export const FLAP_REST_TRANSFORM = "rotateX(0deg)";
export const FLAP_HIDDEN_TRANSFORM = "rotateX(90deg)";
export const FLAP_TRAVEL_TILT: readonly [string, string] = [
  "rotateX(0deg)",
  "rotateX(-34deg)",
];

/** Attribute hooks the animator uses to find the parts it owns. */
export const FLAP_FACE_ATTR = "data-flap-face";
export const FLAP_GLYPH_ATTR = "data-flap-glyph";

/**
 * How far the recessed window is held in from its grid cell, as a share of the
 * cell. Percentages (not vmin) so the mask lattice stays proportional on any
 * panel: `left`/`right` resolve against the cell's width, `top`/`bottom` against
 * its height.
 *
 * Measured: a real window is 61 × 97 px on a 68 × 140 px pitch — 90% of the
 * column pitch and 69% of the row pitch. These are those numbers, near enough:
 * the space they leave is the mask, and the mask *is* the lattice.
 */
const WELL_INSET_X = "5.5%";
const WELL_INSET_Y = "13%";

/**
 * How far the flap is held in from its window. Left/right is measured (a real
 * flap is 79% of its window's width). Top and bottom are deliberately not: the
 * real flap is only 66% of the window's height, with a third of it given to the
 * stack, and at 24 columns on a 720p panel that costs more glyph than a TV
 * message board can afford. 74.5% keeps the anatomy and the proportions while
 * leaving the cap height legible across a room.
 */
const FLAP_INSET_X = "7.5%";
const FLAP_TOP = "3%";
const FLAP_BOTTOM = "22%";

/**
 * Real flaps and windows are near-square-cornered — ~2px on a 48px card.
 * Expressed in `em` of the glyph, which is derived from the same `min()` as the
 * tile, so the radius tracks tile size without a second breakpoint. The original
 * `0.12em` was ~4× this, and was the single reason the tiles read as soft UI
 * cards.
 */
const WELL_RADIUS = "0.05em";
const FLAP_RADIUS = "0.03em";

/**
 * The flap's vertical luminance profile, sampled down one real white chip
 * (y 145 → 209 in the product shot) and expressed as black overlays measured down
 * from the brightest region:
 *
 * ```
 *   0–8%     145 → 190   mask lip shadowing the flap's top edge
 *   8–47%    ~198        upper half — measurably *darker* than the lower
 *   48%      176         the upper flap's own bottom edge turning away
 *   49–51%   105 → 115   the seam: a dark hairline, not a bright one
 *   52–97%   ~219        lower half, the brightest region
 *   98%      234         lit bottom lip
 * ```
 */
const FLAP_SURFACE =
  "linear-gradient(to bottom," +
  "rgba(0,0,0,0.32) 0%," +
  "rgba(0,0,0,0.14) 4%," +
  "rgba(0,0,0,0.09) 8%," +
  "rgba(0,0,0,0.09) 46.4%," +
  "rgba(0,0,0,0.24) 47.8%," +
  "rgba(0,0,0,0.60) 48.8%," +
  "rgba(0,0,0,0.56) 51.6%," +
  "rgba(0,0,0,0.05) 53%," +
  "rgba(0,0,0,0.01) 56%," +
  "rgba(0,0,0,0.01) 96%," +
  "rgba(255,255,255,0.08) 98.5%," +
  "rgba(0,0,0,0.26) 100%)";

/**
 * The retaining notch cut into the flap's top edge — the single clearest "this is
 * a mechanical card" signal at close range. Drawn as its own background layer so
 * it can be confined to the top ~11% of the flap; hard stops at identical
 * positions keep the edges crisp rather than feathered.
 */
const FLAP_NOTCH =
  "linear-gradient(to right," +
  "rgba(0,0,0,0) 41.5%," +
  "rgba(0,0,0,0.66) 41.5%," +
  "rgba(0,0,0,0.66) 58.5%," +
  "rgba(0,0,0,0) 58.5%)";

/**
 * The resting stack of cards below the flap, seen edge-on. Painted on the *well*,
 * not the faces: the stack does not move when one card flips, and putting it here
 * costs 144 gradients instead of 288.
 *
 * Opaque stops, not alpha over the well's fill. Measured, the real stack band is
 * ~0.7 × the mask's luminance — about as light as an unlit flap, *not* near-black,
 * and the lines within it are darker than the band rather than lighter. Doing it
 * with alpha over a near-black well gave the opposite (bright lines on black) and
 * read as heavy stripes. Percentage stops so the line pitch scales with the panel
 * instead of pinning to device pixels.
 */
const WELL_STACK =
  "repeating-linear-gradient(to bottom," +
  "#212124 0%," +
  "#212124 13%," +
  "#101013 13%," +
  "#101013 19%," +
  "#212124 19%," +
  "#212124 20%)";

/**
 * The lip of the recess: dark where the mask overhangs the window's top edge, lit
 * where it catches light along the bottom. Two blur-free layers — a fill, not a
 * convolution.
 */
const WELL_SHADOW =
  "0 -1px 0 rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.045)";

/**
 * The palette is board *data*, not UI chrome, so these are literal pigments
 * rather than semantic theme tokens — a red tile must be red on a TV in a lit
 * room regardless of the app's light/dark theme.
 *
 * Retuned from Vestaboard's own product photography rather than picked off a web
 * scale: the real chips are printed plastic, so every hue sits lower in value and
 * lower in chroma than the equivalent Tailwind primary. Hue-clustered medians off
 * the flat-lit product shot were red ~#d70c10, orange ~#d87011, yellow ~#decb03,
 * green ~#28b863, blue ~#1c7cb9, violet ~#9656a0; these are those, pulled a
 * further step off saturation so they read as pigment shaded by the mask rather
 * than as light.
 *
 * `black` is the unlit flap. On the real object it is ~0.78 × the mask's
 * luminance — a *card in shadow*, not a hole. #1f1f22 against the mask's #2a2a2b
 * is 0.58 ×: darker than the real ratio, because a TV in a lit room needs the
 * white glyph on an unlit flap to carry further than a photograph does, but far
 * enough off pure black that the flap still reads as an object. `white` is the
 * default *text* colour, so it is a white glyph on an unlit flap — not a white
 * block, or every ordinary message would be a wall of white. Glyph colours are
 * off-white / near-black rather than #fff / #000; nothing printed is ever either.
 */
export const TILE_COLORS: Readonly<
  Record<BoardColor, { fill: string; ink: string }>
> = {
  black: { fill: "#1f1f22", ink: "#e8e8e5" },
  white: { fill: "#1f1f22", ink: "#f5f5f1" },
  red: { fill: "#c3352d", ink: "#f8f0ec" },
  orange: { fill: "#ce6b22", ink: "#17120c" },
  yellow: { fill: "#d8be2e", ink: "#17140a" },
  green: { fill: "#2e9b58", ink: "#f1f6f0" },
  blue: { fill: "#2b77ac", ink: "#f0f5f9" },
  violet: { fill: "#86529a", ink: "#f4eff7" },
};

export interface FlapTileProps {
  readonly char: string;
  readonly color: BoardColor;
}

/**
 * The well: the recessed window. Carries the lip shadow (which has to sit on an
 * element *behind* the faces to be visible outside them), the stack band, and
 * the perspective — without which the rotation reads as a vertical squash rather
 * than a hinge. Hoisted out of the component because it is the same object for
 * all 144 tiles.
 */
const WELL_STYLE: CSSProperties = {
  top: WELL_INSET_Y,
  bottom: WELL_INSET_Y,
  left: WELL_INSET_X,
  right: WELL_INSET_X,
  borderRadius: WELL_RADIUS,
  backgroundColor: "#0e0e10",
  backgroundImage: WELL_STACK,
  // The stack occupies the bottom band of the window, below the flap.
  backgroundSize: `100% ${FLAP_BOTTOM}`,
  backgroundPosition: "50% 100%",
  backgroundRepeat: "no-repeat",
  boxShadow: WELL_SHADOW,
};

/**
 * Inset inside the window rather than filling it, so the well's own fill shows
 * through as the recess walls, top lip and stack band — and so the glyph, centred
 * in the flap, lands where a real one does: above the window's midline, with the
 * seam crossing it.
 */
const faceStyle = (color: BoardColor, active: boolean): CSSProperties => {
  const pigment = TILE_COLORS[color];
  return {
    top: FLAP_TOP,
    bottom: FLAP_BOTTOM,
    left: FLAP_INSET_X,
    right: FLAP_INSET_X,
    borderRadius: FLAP_RADIUS,
    backgroundColor: pigment.fill,
    backgroundImage: `${FLAP_NOTCH}, ${FLAP_SURFACE}`,
    backgroundSize: "100% 11%, 100% 100%",
    backgroundPosition: "50% 0, 0 0",
    backgroundRepeat: "no-repeat, no-repeat",
    color: pigment.ink,
    // The landing flip's duration. The animator overwrites this per flap: 0ms
    // while travelling (an instant cut), back to the landing duration to flip.
    transitionDuration: `${FLAP_LAND_MS}ms`,
    // Hinge at the flap's midline, like a real split-flap.
    transformOrigin: "center center",
    transform: active ? FLAP_REST_TRANSFORM : FLAP_HIDDEN_TRANSFORM,
    opacity: active ? 1 : 0,
    // A hidden face must never eat the visible one's pixels.
    zIndex: active ? 1 : 0,
  };
};

const FACE_CLASS = cn(
  "absolute flex items-center justify-center overflow-hidden",
  // A grotesque, not a monospace. Every glyph already owns a flap, so nothing
  // here needs a fixed advance — and the mono face was the reason the characters
  // read as "geometric web font" rather than as the tighter industrial cut on a
  // real flap.
  "font-sans leading-none font-semibold select-none",
  // Only transform + opacity animate. `motion-reduce:transition-none` is a plain
  // media query and sets `transition-property: none`, which the animator's
  // inline `transition-duration` cannot undo — so reduced motion stays an
  // instant swap even though JS is writing durations.
  "transition-[transform,opacity] ease-out motion-reduce:transition-none"
);

export function FlapTile({ char, color }: FlapTileProps) {
  /**
   * The cell as it was on the very first render, captured once and never
   * updated. Everything below is memoised on it, so its stability is what keeps
   * React out of the faces for the lifetime of the board.
   */
  const initial = useRef({ char, color }).current;

  const well = useMemo(
    () => (
      <div
        className="absolute [perspective:400px]"
        style={WELL_STYLE}
        // The board itself is `role="img"` with a text alternative, so the flaps
        // are decoration as far as a screen reader is concerned — and mid-travel
        // they are literally showing the wrong letters.
        aria-hidden
      >
        {([0, 1] as const).map((index) => (
          <span
            key={index}
            {...{ [FLAP_FACE_ATTR]: index }}
            className={FACE_CLASS}
            style={faceStyle(initial.color, index === 0)}
          >
            {/*
              Inter has no condensed cut and `font-stretch` does nothing to a
              static face, so the condensation is a horizontal scale. It has to
              be its own element: putting `scaleX` on the face would squash the
              flap itself. A static 2D transform, so it does not promote a layer
              and does not touch the flip's transform. It is also the element the
              animator writes `textContent` into, ~14 times a second per moving
              tile — one text node, no attributes, no children.
            */}
            <span
              {...{ [FLAP_GLYPH_ATTR]: "" }}
              className="block"
              style={{ transform: "scaleX(0.85)" }}
            >
              {initial.char === " " ? "" : initial.char}
            </span>
          </span>
        ))}
      </div>
    ),
    [initial]
  );

  return (
    // The grid cell. Larger than the window on purpose — the difference is the
    // frame's mask showing through, which is what the lattice actually is.
    //
    // `data-char` / `data-color` are the *target*, not what is on screen: the two
    // attributes React still owns, so a test can read where the board is headed
    // (and, once settled, where it got to).
    <div className="relative" data-testid="flap-tile" data-char={char} data-color={color}>
      {well}
    </div>
  );
}
