import { describe, it, expect } from "vitest";
import type { AppLoadContext } from "react-router";
import {
  requireSession,
  requireAdmin,
  redirectIfAuthenticated,
  resolveSignedInHome,
  safeNextPath,
  loginRedirectUrl,
  pairingCodeFromNext,
} from "../session";

const makeContext = (session: unknown): AppLoadContext =>
  ({
    auth: {
      api: {
        getSession: async () => session,
      },
    },
  }) as unknown as AppLoadContext;

const request = (url = "http://localhost/") => new Request(url);

async function expectRedirect(promise: Promise<unknown>, location: string) {
  try {
    await promise;
    expect.fail("expected a redirect to be thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    const response = error as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(location);
  }
}

describe("requireSession", () => {
  it("returns the session when present", async () => {
    const session = { session: {}, user: { id: "u1", role: "user" } };
    const result = await requireSession(request(), makeContext(session));
    expect(result).toBe(session);
  });

  it("redirects to /login with the gated URL as ?next= when there is no session", async () => {
    await expectRedirect(
      requireSession(request(), makeContext(null)),
      "/login?next=%2F"
    );
  });

  it("preserves the gated page's path and query in ?next=", async () => {
    await expectRedirect(
      requireSession(request("http://localhost/boards?page=2"), makeContext(null)),
      "/login?next=%2Fboards%3Fpage%3D2"
    );
  });

  it("sends an anonymous QR scan to sign-up rather than sign-in", async () => {
    // The gate is what knows the visitor was *sent*; see `loginRedirectUrl`.
    await expectRedirect(
      requireSession(
        request("http://localhost/link?code=GHPLXX"),
        makeContext(null)
      ),
      "/sign-up?next=%2Flink%3Fcode%3DGHPLXX"
    );
  });
});

describe("requireAdmin", () => {
  it("returns the session when the user is an admin", async () => {
    const session = { session: {}, user: { id: "u1", role: "admin" } };
    const result = await requireAdmin(request(), makeContext(session));
    expect(result).toBe(session);
  });

  it("redirects to /boards when the user is not an admin", async () => {
    const session = { session: {}, user: { id: "u1", role: "user" } };
    await expectRedirect(
      requireAdmin(request(), makeContext(session)),
      "/boards"
    );
  });

  it("redirects to /login when there is no session", async () => {
    await expectRedirect(
      requireAdmin(request(), makeContext(null)),
      "/login?next=%2F"
    );
  });
});

describe("redirectIfAuthenticated", () => {
  it("redirects to / by default when a session exists — the index resolves the real home", async () => {
    const session = { session: {}, user: { id: "u1", role: "user" } };
    await expectRedirect(
      redirectIfAuthenticated(request(), makeContext(session)),
      "/"
    );
  });

  it("redirects to a custom destination", async () => {
    const session = { session: {}, user: { id: "u1", role: "user" } };
    await expectRedirect(
      redirectIfAuthenticated(request(), makeContext(session), "/somewhere"),
      "/somewhere"
    );
  });

  it("does nothing when there is no session", async () => {
    await expect(
      redirectIfAuthenticated(request(), makeContext(null))
    ).resolves.toBeUndefined();
  });
});

describe("resolveSignedInHome", () => {
  it("sends a household with one board straight to its controller", () => {
    expect(resolveSignedInHome([{ id: "b1" }])).toBe("/b/b1/c");
  });

  it("encodes the id — a board id reaches the path, so it has to be escaped", () => {
    expect(resolveSignedInHome([{ id: "a b/c" }])).toBe("/b/a%20b%2Fc/c");
  });

  it("sends a new account to the rack, which is where the TV address is taught", () => {
    expect(resolveSignedInHome([])).toBe("/boards");
  });

  it("sends a multi-TV household to the rack — there is a real question to answer", () => {
    expect(resolveSignedInHome([{ id: "b1" }, { id: "b2" }])).toBe("/boards");
  });
});

describe("safeNextPath", () => {
  it("accepts same-origin absolute paths", () => {
    expect(safeNextPath("/boards")).toBe("/boards");
    expect(safeNextPath("/link?code=GHPLXX")).toBe("/link?code=GHPLXX");
  });

  it("rejects scheme-relative URLs (open redirect)", () => {
    expect(safeNextPath("//evil.com")).toBeNull();
    expect(safeNextPath("//evil.com/login")).toBeNull();
  });

  it("rejects backslash scheme-relative URLs — WHATWG normalises /\\ to // on https", () => {
    expect(safeNextPath("/\\evil.com")).toBeNull();
    expect(safeNextPath("/\\evil.com/login")).toBeNull();
  });

  it("rejects absolute and relative URLs", () => {
    expect(safeNextPath("https://evil.com")).toBeNull();
    expect(safeNextPath("http://evil.com")).toBeNull();
    expect(safeNextPath("dashboard")).toBeNull();
  });

  it("rejects missing and empty values", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath("")).toBeNull();
  });
});

describe("pairingCodeFromNext", () => {
  it("reads the code a gated /link visit carried into ?next=", () => {
    expect(pairingCodeFromNext("/link?code=GHPLXX")).toBe("GHPLXX");
  });

  it("normalizes presentation the way the code field does", () => {
    // A TV free to print `GHPL-XX` for legibility must not force the owner (or
    // this helper) to reproduce the grouping.
    expect(pairingCodeFromNext("/link?code=ghpl-xx")).toBe("GHPLXX");
  });

  it("is null for any other destination", () => {
    expect(pairingCodeFromNext("/boards")).toBeNull();
    expect(pairingCodeFromNext("/link")).toBeNull();
    // Not `/link`: a prefix match here would read a code out of a path the
    // pairing flow never uses.
    expect(pairingCodeFromNext("/linkedin?code=GHPLXX")).toBeNull();
  });

  it("is null for a code that is not one", () => {
    expect(pairingCodeFromNext("/link?code=SHORT")).toBeNull();
    // `0`, `1`, `I` and `O` are absent from the alphabet on purpose — a code
    // containing one was misread, and refusing beats silently substituting.
    expect(pairingCodeFromNext("/link?code=GHPL0X")).toBeNull();
  });

  it("re-applies the open-redirect guard rather than trusting its caller", () => {
    expect(pairingCodeFromNext(null)).toBeNull();
    expect(pairingCodeFromNext("")).toBeNull();
    expect(pairingCodeFromNext("//evil.com/link?code=GHPLXX")).toBeNull();
    expect(pairingCodeFromNext("/\\evil.com/link?code=GHPLXX")).toBeNull();
    expect(pairingCodeFromNext("https://evil.com/link?code=GHPLXX")).toBeNull();
  });
});

describe("loginRedirectUrl", () => {
  it("carries the gated path and query as ?next=", () => {
    expect(loginRedirectUrl(request("http://localhost/boards?page=2"))).toBe(
      "/login?next=%2Fboards%3Fpage%3D2"
    );
  });

  it("uses the bare path when there is no query", () => {
    expect(loginRedirectUrl(request("http://localhost/boards"))).toBe(
      "/login?next=%2Fboards"
    );
  });

  it("sends a pairing arrival to sign-up instead of sign-in", () => {
    // Somebody who just scanned the code on their own television has no
    // account. This is the only place that knows they were *sent* here rather
    // than that they chose to sign in, which is why the choice lives here and
    // not in `/login`'s loader.
    expect(loginRedirectUrl(request("http://localhost/link?code=GHPLXX"))).toBe(
      "/sign-up?next=%2Flink%3Fcode%3DGHPLXX"
    );
  });

  it("keeps a codeless /link visit on sign-in", () => {
    expect(loginRedirectUrl(request("http://localhost/link"))).toBe(
      "/login?next=%2Flink"
    );
  });
});
