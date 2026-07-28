import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The enclosure the board is mounted in.
 *
 * A real split-flap unit is not a field of coloured rectangles — it is an
 * aluminium extrusion holding a single matte mask, with a recessed window
 * punched out for every flap. Three facts about that object drive everything
 * here, and all three were measured off Vestaboard's own product photography
 * (`vb-front.jpg`, `vestaboard-flaps-sq.jpg`):
 *
 * 1. **The mask is lighter than the flaps.** Mask reads ~#2c2c2c; an unlit flap
 *    sits around #131316. So a dark tile is a *hole* in a mid-charcoal surface,
 *    not a light card on a black page. The previous render had that inverted,
 *    which is why the gaps looked like a decorative dot lattice.
 * 2. **The mask is continuous.** The area between two flaps is the same piece of
 *    metal as the border around the whole field — so the grid is transparent and
 *    every gap shows this component's surface straight through.
 * 3. **There is a frame.** ~7% of the width on a real unit. We can't spend that
 *    much (the field has to stay 2:1 and still fill a 16:9 panel), so the bezel
 *    is 5.5vmin — enough that the board reads as an object, cheap enough that
 *    the glyphs only lose ~7%.
 *
 * Cost control: the entire enclosure is two elements and four paint layers
 * total, no matter how many tiles are inside it. Everything is a flat fill, a
 * linear gradient, a radial gradient, or a blur-free inset shadow — the things a
 * several-years-old Tizen compositor is actually fast at.
 */

/** Width of the aluminium lip around the mask. */
const EXTRUSION = "0.7vmin";

/**
 * Top-lit vertical fall-off across the mask. Neutral, not blue: the measured
 * mask is #2c2c2c, dead grey, and the first pass drifted 5 points blue which read
 * as a dark *UI theme* rather than as painted metal. Deliberately shallow
 * (#2d2d2e → #232324) too — a steeper ramp would let the bottom row's mask get as
 * dark as the unlit flaps and the lattice would vanish in row 6.
 */
// Exported so the phone's miniature preview can quote the real mask instead of
// keeping its own copy of these stops — one source of truth, or retuning the
// board silently desyncs the controller.
export const MASK_FILL =
  "linear-gradient(180deg, #2d2d2e 0%, #2a2a2b 34%, #272728 70%, #232324 100%)";

/**
 * One broad off-centre sheen and one corner vignette. Kept as two wide radials
 * rather than a stack of highlights — they are two paints over the whole frame,
 * once, no matter how many tiles sit on top, and together they are what stops the
 * mask reading as flat #2a2a2a.
 */
const MASK_SHEEN =
  "radial-gradient(115% 85% at 27% 4%, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 38%, rgba(255,255,255,0) 68%)";
const MASK_VIGNETTE =
  "radial-gradient(135% 118% at 50% 44%, rgba(0,0,0,0) 42%, rgba(0,0,0,0.16) 74%, rgba(0,0,0,0.4) 100%)";

export interface BoardFrameProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function BoardFrame({ children, className }: BoardFrameProps) {
  return (
    <div
      className={cn(
        "relative flex h-screen w-screen items-center justify-center overflow-hidden",
        className
      )}
      style={{
        padding: EXTRUSION,
        backgroundColor: "#414145",
        // The extrusion catches light on its top edge and loses it on the
        // bottom. Both layers are blur-free, so they cost a fill, not a blur.
        boxShadow:
          "inset 0 0.18vmin 0 rgba(255,255,255,0.24), inset 0 -0.18vmin 0 rgba(0,0,0,0.7)",
      }}
      data-testid="board-frame"
    >
      <div
        className="relative flex h-full w-full items-center justify-center overflow-hidden"
        style={{
          backgroundColor: "#2a2a2b",
          backgroundImage: `${MASK_VIGNETTE}, ${MASK_SHEEN}, ${MASK_FILL}`,
          // The mask is set *behind* the lip, so the lip shades its edges — plus
          // one hairline where the two meet, which is the whole reason the lip
          // reads as a separate piece of metal rather than a border.
          boxShadow:
            "inset 0 0 0 1px rgba(0,0,0,0.55), inset 0 0.4vmin 1.1vmin rgba(0,0,0,0.5), inset 0 -0.25vmin 0.7vmin rgba(0,0,0,0.38)",
        }}
      >
        {children}

        {/*
          Etched into the bottom bezel, exactly where the real unit puts its
          wordmark. Engraving, not printing: the glyphs are a dark cut and the
          light sits on the lower edge of the cut. Decorative and duplicated by
          nothing, so it is hidden from the accessibility tree — the board's own
          text alternative is the only thing a screen reader should find here.
        */}
        <span
          aria-hidden
          className="absolute bottom-[1.5vmin] left-1/2 -translate-x-1/2 font-medium uppercase"
          style={{
            fontSize: "1.45vmin",
            letterSpacing: "0.62em",
            // The tracking is applied on the right of the last glyph too, so the
            // string is optically off-centre without half of it back.
            marginLeft: "0.31em",
            color: "rgba(0,0,0,0.55)",
            textShadow: "0 0.13vmin 0 rgba(255,255,255,0.11)",
          }}
        >
          Flappyboard
        </span>
      </div>
    </div>
  );
}
