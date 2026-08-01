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
