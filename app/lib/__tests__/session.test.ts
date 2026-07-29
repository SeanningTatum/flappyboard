import { describe, it, expect } from "vitest";
import type { AppLoadContext } from "react-router";
import {
  requireSession,
  requireAdmin,
  redirectIfAuthenticated,
  safeNextPath,
  loginRedirectUrl,
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
      requireSession(
        request("http://localhost/link?code=GHPLXX"),
        makeContext(null)
      ),
      "/login?next=%2Flink%3Fcode%3DGHPLXX"
    );
  });
});

describe("requireAdmin", () => {
  it("returns the session when the user is an admin", async () => {
    const session = { session: {}, user: { id: "u1", role: "admin" } };
    const result = await requireAdmin(request(), makeContext(session));
    expect(result).toBe(session);
  });

  it("redirects to /dashboard when the user is not an admin", async () => {
    const session = { session: {}, user: { id: "u1", role: "user" } };
    await expectRedirect(
      requireAdmin(request(), makeContext(session)),
      "/dashboard"
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
  it("redirects to /dashboard by default when a session exists", async () => {
    const session = { session: {}, user: { id: "u1", role: "user" } };
    await expectRedirect(
      redirectIfAuthenticated(request(), makeContext(session)),
      "/dashboard"
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

describe("safeNextPath", () => {
  it("accepts same-origin absolute paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
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

describe("loginRedirectUrl", () => {
  it("carries the gated path and query as ?next=", () => {
    expect(
      loginRedirectUrl(request("http://localhost/link?code=GHPLXX"))
    ).toBe("/login?next=%2Flink%3Fcode%3DGHPLXX");
  });

  it("uses the bare path when there is no query", () => {
    expect(loginRedirectUrl(request("http://localhost/boards"))).toBe(
      "/login?next=%2Fboards"
    );
  });
});
