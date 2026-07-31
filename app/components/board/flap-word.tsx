import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { normalizeText } from "@/lib/board/compile";
import { MASK_FILL } from "@/components/board/console";
import { FlapTile } from "@/components/board/flap-tile";
import type { BoardColor } from "@/lib/schemas/board";

/**
 * A short string rendered as real flaps — the board's own lettering, used
 * outside the board.
 *
 * This exists because of a finding the brand pass could not argue with: the
 * eight pigments were tokenized and then never spent, so everything a visitor
 * meets before the television is monochrome. The board *is* the brand, and the
 * cheapest honest way to say that on a phone is to set the words that matter in
 * the same hardware the product is made of: the pairing code on the TV, and each
 * board's nameplate on the rack.
 *
 * ## What this is NOT
 *
 * Not a board. There is no socket, no `BoardGrid`, and above all **no animator**
 * — `board-grid-view.tsx`'s `requestAnimationFrame` loop owns that, it is tuned
 * for 144 tiles, and it is frozen. A `FlapTile` paints its faces from the cell
 * present on its first render and never revisits them (see the memo in that
 * file), so a changed character here would otherwise never appear.
 *
 * The fix is the `key`: a tile is keyed by its character, so a changed character
 * is a *remount* — new tile, new initial face, correct glyph. That makes a
 * change an instant cut rather than a flip, which is the honest trade. Adding a
 * flip would mean either a second animator or reaching into the frozen one, and
 * the value on a six-character code that rotates every few minutes does not pay
 * for either.
 *
 * ## Geometry, and why it is not `aspect-ratio`
 *
 * `FlapTile` positions itself in percentages of its grid cell and takes its
 * glyph size from the field's inherited `font-size`, so all this component owes
 * it is: a grid, cells at the board's real 1:2 pitch, a font size, and the mask
 * behind — the gaps between flaps are painted metal showing through, never the
 * page.
 *
 * The pitch is stated as **explicit width and height derived from one cell
 * width**, not as `aspect-ratio`. `aspect-ratio` is Chromium 88; the Samsung
 * Tizen panel this has to render a pairing code on is Chromium 56, where the
 * property is ignored and a grid with no intrinsic height collapses to nothing.
 * `board-grid-view.tsx` survives that only because its display variant also sets
 * an explicit `width`/`height` — the `aspectRatio` beside them is belt and
 * braces, and copying just the braces here would have shipped a blank rectangle
 * to exactly the device that most needs the code.
 *
 * The glyph is `0.923 ×` the cell, which is the board's own ratio: its field is
 * 24 columns wide and its glyph size divides that width by 26.
 */

export interface FlapWordProps {
  /** Folded to the board's charset and uppercased, exactly like a message. */
  readonly text: string;
  /** The pigment every flap is painted. Defaults to the unlit flap. */
  readonly color?: BoardColor;
  /**
   * The width of one flap, as any CSS length — a `vmin` on a television, a `px`
   * on a phone. Everything else is derived from it: a tile is twice as tall as
   * it is wide, so this fixes the whole block's size without `aspect-ratio`.
   */
  readonly cellWidth: string;
  /**
   * Pad or clip to exactly this many tiles. A pairing code is always six wide
   * whatever the string does, and a nameplate that reflows as it is typed is a
   * distraction rather than a readout.
   */
  readonly cells?: number;
  /** Read out instead of the individual flaps, which are decoration. */
  readonly label?: string;
  readonly className?: string;
  readonly "data-testid"?: string;
}

export function FlapWord({
  text,
  color = "black",
  cellWidth,
  cells,
  label,
  className,
  "data-testid": testId,
}: FlapWordProps) {
  const chars = useMemo(() => {
    // The same fold the board applies to a message: uppercase, unsupported
    // characters dropped. Doing it here rather than trusting the caller means a
    // board named "Kai's room" cannot render a tile the charset has no flap for.
    const folded = normalizeText(text);
    if (cells === undefined) return folded.split("");
    return folded.slice(0, cells).padEnd(cells, " ").split("");
  }, [text, cells]);

  return (
    <div
      className={cn("grid", className)}
      style={{
        gridTemplateColumns: `repeat(${chars.length}, ${cellWidth})`,
        width: `calc(${cellWidth} * ${chars.length})`,
        // The board's pitch: a flap is twice as tall as it is wide.
        height: `calc(${cellWidth} * 2)`,
        fontSize: `calc(${cellWidth} * 0.923)`,
        backgroundImage: MASK_FILL,
      }}
      role="img"
      aria-label={label ?? text}
      data-testid={testId}
      // The string itself, as an attribute. The flaps render each glyph twice
      // (two stacked faces), so this element's `textContent` is doubled and
      // useless to a test or a verification script — this is what they read.
      data-text={text}
    >
      {chars.map((char, index) => (
        // Keyed by the character — see the note above. The index is in the key
        // as well so two identical characters stay distinct siblings.
        //
        // A blank stays UNLIT whatever the pigment is. Painting the padding
        // gives an 11-character name on an 18-flap plate seven coloured cards
        // with nothing on them, which reads as damage rather than as a word —
        // and it is not what the real object does either: on a Vestaboard the
        // colour is the character, and the rest of the row is unlit flap.
        <FlapTile
          key={`${index}-${char}`}
          char={char}
          color={char === " " ? "black" : color}
        />
      ))}
    </div>
  );
}

/**
 * Which pigment a board's nameplate is painted, derived from its id.
 *
 * Stable (the same board is always the same colour, on every device and after
 * every deploy) and spread over the six *coloured* pigments.
 *
 * `black` and `white` are both excluded, and for the same reason rather than
 * two: on the real object they **share a fill** — `white` is a white glyph on
 * an unlit flap, and `black` is an unlit flap (see `TILE_COLORS`). So a
 * nameplate assigned `white` would be visually identical to the unlit padding
 * beside it and would carry no identity at all, which is the one job this
 * function has.
 *
 * This is identity, not status: a household with three televisions should be
 * able to find the kitchen one by colour before reading a word, which is the
 * single thing a monochrome list of names cannot do.
 */
const NAMEPLATE_PIGMENTS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
] as const satisfies ReadonlyArray<BoardColor>;

export const nameplatePigment = (boardId: string): BoardColor => {
  // FNV-1a. Chosen over `reduce`-and-multiply because it avoids the sign
  // trouble a naive hash hits on long ids, and it is four lines.
  let hash = 0x811c9dc5;
  for (let index = 0; index < boardId.length; index += 1) {
    hash ^= boardId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return NAMEPLATE_PIGMENTS[hash % NAMEPLATE_PIGMENTS.length]!;
};
