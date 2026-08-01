import { describe, it, expect } from "vitest";

import { defaultBoardName } from "../link";

/*
  `resolveAutoLink` and its three tests were deleted with the board-count branch
  they described. There is no decision left to make: scanning a television's
  code always creates the board that television will show, so 0 / 1 / many
  accounts all take the same path. See the header of `../link.tsx`.
*/

describe("defaultBoardName", () => {
  it("is English for English and unknown locales", () => {
    expect(defaultBoardName("en")).toBe("Living Room");
    expect(defaultBoardName("fr")).toBe("Living Room");
  });

  it("is Chinese for zh locales, including regional variants", () => {
    expect(defaultBoardName("zh")).toBe("客厅");
    expect(defaultBoardName("zh-CN")).toBe("客厅");
  });
});
