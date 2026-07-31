import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import { ThemeProvider } from "next-themes";

import type { Route } from "./+types/root";
import "./app.css";
import archivo400 from "./assets/fonts/archivo-400.woff2?url";
import archivo600 from "./assets/fonts/archivo-600.woff2?url";
import plexMono400 from "./assets/fonts/ibm-plex-mono-400.woff2?url";
import { TRPCProvider } from "./trpc/client";
import { useTranslation } from "react-i18next";
import { useChangeLanguage } from "remix-i18next/react";
import { i18nServer } from "./i18n/i18n.server";

export const handle = { i18n: ["common"] };

/*
 * The typefaces are self-hosted (see `app.css`), so there is no stylesheet to
 * fetch and no third-party origin to warm up. These imports resolve to
 * content-hashed URLs under `/assets/`, which is what lets `public/_headers`
 * cache them immutably.
 *
 * `crossOrigin: "anonymous"` is mandatory even though these are same-origin:
 * fonts are always fetched in CORS mode, so a preload without it is treated as
 * a different request than the one `@font-face` makes — the preload is
 * discarded and the file is fetched twice.
 *
 * Only the app-wide faces are preloaded here. The flap face is preloaded by the
 * board routes themselves, since nothing outside a board renders a tile.
 */
export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    href: archivo400,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
  {
    rel: "preload",
    href: archivo600,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
  {
    rel: "preload",
    href: plexMono400,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

export async function loader({ request }: Route.LoaderArgs) {
  const locale = await i18nServer.getLocale(request);
  return { locale };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const loaderData = useRouteLoaderData("root") as
    | { locale: string }
    | undefined;
  const locale = loaderData?.locale ?? "en";

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  useChangeLanguage(loaderData.locale);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TRPCProvider>
        <Outlet />
      </TRPCProvider>
    </ThemeProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { t } = useTranslation("common");

  let message = t("errors.oops");
  let details = t("errors.unexpected");
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? t("errors.404") : t("errors.error");
    details =
      error.status === 404
        ? t("errors.not_found")
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
