import { describe, expect, it } from "vitest";

import {
  FLAP_ADDRESS_MAX_CHARS,
  addressFitsFlaps,
  tvAddress,
} from "../tv-address";

describe("the address a television is pointed at", () => {
  it("is derived from the request, not from configuration", () => {
    expect(tvAddress("https://flappyboard.app/")).toEqual({
      href: "https://flappyboard.app/tv",
      display: "flappyboard.app/tv",
    });
  });

  it("keeps a non-default port, because dev and preview both have one", () => {
    expect(tvAddress("http://localhost:5173/")).toEqual({
      href: "http://localhost:5173/tv",
      display: "localhost:5173/tv",
    });
  });

  /** The scheme is eight keystrokes on a TV remote; every TV browser adds it. */
  it("drops the scheme from what a person has to type", () => {
    expect(tvAddress("https://board.example.com/").display).not.toContain("://");
  });

  it("ignores the path and query it was called from", () => {
    expect(tvAddress("https://flappyboard.app/anything?next=%2Flink")).toEqual({
      href: "https://flappyboard.app/tv",
      display: "flappyboard.app/tv",
    });
  });
});

/**
 * The auth band sets this address on real flaps, so it needs the same
 * caller-side check `foldsToFlaps` gives a board name: when the string will not
 * survive the hardware, fall back to type rather than paint wrong or unreadable
 * tiles. The failure mode here is not overflow — the tiles are sized to fit —
 * it is a 42-character hostname arriving as an 8px pattern nobody can retype.
 */
describe("whether an address can be set on flaps", () => {
  it("accepts an ordinary host, with its port and its slash", () => {
    expect(addressFitsFlaps("localhost:5173/tv")).toBe(true);
    expect(addressFitsFlaps("flappyboard.app/tv")).toBe(true);
    expect(addressFitsFlaps("board.example.com/tv")).toBe(true);
  });

  it("refuses a hostname too long to read on a phone", () => {
    // The real preview worker, which is exactly the case this guards.
    expect(
      addressFitsFlaps("flappyboard-preview.example.workers.dev/tv")
    ).toBe(false);
  });

  it("draws the line at the documented length, not near it", () => {
    const at = `${"a".repeat(FLAP_ADDRESS_MAX_CHARS - 3)}/tv`;
    expect(at).toHaveLength(FLAP_ADDRESS_MAX_CHARS);
    expect(addressFitsFlaps(at)).toBe(true);
    expect(addressFitsFlaps(`a${at}`)).toBe(false);
  });

  /**
   * The charset is fixed hardware and carries no underscore. An address that
   * folds to something *different* from itself would render tiles spelling a
   * different address, which is worse than plain type by a wide margin.
   */
  it("refuses anything the charset would silently rewrite", () => {
    expect(addressFitsFlaps("a_b.example/tv")).toBe(false);
  });
});
