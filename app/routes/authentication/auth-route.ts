import type { AppLoadContext } from "react-router";

import { i18nServer } from "@/i18n/i18n.server";
import { tvAddress } from "@/lib/board/tv-address";
import {
  pairingCodeFromNext,
  redirectIfAuthenticated,
  safeNextPath,
} from "@/lib/session";
import type { AuthMode } from "./components/auth-page";

/**
 * Everything `/login` and `/sign-up` need from the server, resolved once.
 *
 * The two routes render **one surface** with a segmented toggle, so they must
 * not drift in what they load — a `next` validated one way on one page and
 * another way on the other is exactly the kind of gap an open-redirect lives in.
 *
 * Type-only import of `AuthMode` from the component: this module reaches
 * `i18nServer`, and a component that imported *it* would drag the server i18n
 * bundle into the browser.
 */
export interface AuthRouteData {
  /** Validated by `safeNextPath` — never off-origin, never `//host`. */
  readonly next: string | null;
  /** The device code `next` is carrying, if the visitor arrived from a TV. */
  readonly code: string | null;
  readonly tv: ReturnType<typeof tvAddress>;
  readonly title: string;
  readonly description: string;
}

export async function authRouteData(
  request: Request,
  context: AppLoadContext,
  mode: AuthMode
): Promise<AuthRouteData> {
  const next = safeNextPath(new URL(request.url).searchParams.get("next"));

  /*
    An already-signed-in visitor has nothing to answer here, so they go straight
    on to wherever they were headed.

    `next ?? "/"` — **not** `/dashboard`, which is what both of these loaders
    passed until now. That route was deleted in phase 2 and has only "worked"
    since through the forwarding shim, at the price of an extra round trip on
    every visit and a hard failure the day the shim retires. `/` is the one
    place that resolves where a session actually belongs (`resolveSignedInHome`).
  */
  await redirectIfAuthenticated(request, context, next ?? "/");

  /*
    `<title>` and `<meta>` render outside the tree i18next is bound to, so they
    cannot see `useTranslation` — resolved here with `getFixedT` or they ship in
    English to a `zh` visitor.
  */
  const t = await i18nServer.getFixedT(request, "auth");

  return {
    next,
    code: pairingCodeFromNext(next),
    // Derived from the request, not from configuration — see `tv-address.ts`.
    tv: tvAddress(request.url),
    title: t(mode === "sign-in" ? "meta.sign_in_title" : "meta.sign_up_title"),
    description: t("meta.description"),
  };
}
