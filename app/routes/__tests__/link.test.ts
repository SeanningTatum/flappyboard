import { describe, it, expect } from "vitest";

import { defaultBoardName, resolveAutoLink } from "../link";

describe("resolveAutoLink", () => {
  it("creates a board when the account has none", () => {
    expect(resolveAutoLink(0)).toBe("create");
  });

  it("pairs the one board when the account has exactly one", () => {
    expect(resolveAutoLink(1)).toBe("single");
  });

  it("asks when the account has several boards — guessing pairs the wrong TV", () => {
    expect(resolveAutoLink(2)).toBe("pick");
    expect(resolveAutoLink(12)).toBe("pick");
  });
});

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
