import { describe, expect, it } from "vitest";

import { tvAddress } from "../tv-address";

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
