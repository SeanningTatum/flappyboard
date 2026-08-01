import { normalizeText } from "@/lib/board/compile";

export interface TvAddress {
  /** Absolute, for a link or the clipboard. */
  readonly href: string;
  /** What a person types into a television: host and path, no scheme. */
  readonly display: string;
}

/**
 * The one instruction the product cannot leave out — *on your TV's browser, go
 * to `yourhost/tv`* — derived from the request rather than from configuration.
 *
 * Taken from the request for the same reason `/boards` does it
 * (`routes/boards/_index.tsx`): the address has to be right on localhost, on a
 * preview deployment and in production without anybody setting a base URL, and
 * a visitor cannot be expected to know their own origin.
 *
 * The scheme is dropped from `display` on purpose. This string is read off a
 * phone and typed into a television remote one letter at a time, and `https://`
 * is eight keystrokes every TV browser adds by itself. `href` keeps the origin
 * for anything that needs a real URL.
 */
export const tvAddress = (requestUrl: string): TvAddress => {
  const url = new URL(requestUrl);
  return { href: `${url.origin}/tv`, display: `${url.host}/tv` };
};

/**
 * The longest address that still reads as *flaps* rather than as texture.
 *
 * The auth band sizes its tiles to fit the container, so a longer string does
 * not overflow — it shrinks. At 390 CSS px the band has ~350px of room, so 21
 * characters lands a 16px-wide tile with a ~15px glyph, which is the floor for
 * something a person reads off a phone and retypes on a television remote one
 * letter at a time. A 42-character preview hostname would land at 8px and be a
 * pattern, not an address.
 */
export const FLAP_ADDRESS_MAX_CHARS = 21;

/**
 * Whether an address can be set on real flaps.
 *
 * The same caller-side check `foldsToFlaps` exists for (`flap-word.tsx`): the
 * board's charset is fixed hardware, so anything that will not survive the fold
 * — or will survive it too small to read — falls back to type rather than
 * rendering a row of wrong or unreadable tiles.
 *
 * `BOARD_CHARS` happens to carry `:`, `.`, `/` and the digits, so an ordinary
 * `host:port/tv` folds unchanged. What it does not carry is lower case, and it
 * does not need to: hostnames are case-insensitive and React Router matches
 * paths case-insensitively by default, so `LOCALHOST:5173/TV` is a working
 * address. The exact string is printed under the flaps anyway — see the band.
 */
export const addressFitsFlaps = (display: string): boolean => {
  const upper = display.toUpperCase();
  return upper.length <= FLAP_ADDRESS_MAX_CHARS && normalizeText(upper) === upper;
};
