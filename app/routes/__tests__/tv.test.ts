import { describe, it, expect } from "vitest";

import { tvLinkUrl } from "../tv";

describe("tvLinkUrl", () => {
  it("points at /link with the code in the query", () => {
    expect(tvLinkUrl("http://localhost:5173/tv", "GHPLXX")).toBe(
      "http://localhost:5173/link?code=GHPLXX"
    );
  });

  it("uses the request origin, so preview and production encode their own host", () => {
    expect(tvLinkUrl("https://flappyboard.workers.dev/tv", "T8TRA3")).toBe(
      "https://flappyboard.workers.dev/link?code=T8TRA3"
    );
  });

  it("drops any query or hash on the page URL itself", () => {
    expect(tvLinkUrl("http://localhost:5173/tv?stale=1#frag", "ABC123")).toBe(
      "http://localhost:5173/link?code=ABC123"
    );
  });
});
