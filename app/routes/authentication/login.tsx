import type { Route } from "./+types/login";
import { AuthPage } from "./components/auth-page";
import { authRouteData } from "./auth-route";
import { authLinks } from "./auth-links";

export const handle = { i18n: ["auth"] };

export const links = authLinks;

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data?.title ?? "Flappyboard" },
  { name: "description", content: data?.description ?? "" },
];

/**
 * There is deliberately **no pairing branch here.** A QR scan that needs an
 * account is routed to `/sign-up` by `loginRedirectUrl` at the moment `/link`
 * gates it — see that function for why the decision belongs at the bounce and
 * not on this page. Redirecting here instead made the surface's own sign-in
 * toggle unreachable for a returning owner adding a second television.
 *
 * `/login?next=%2Flink%3Fcode%3D…` therefore renders normally, with the code set
 * in flaps above the form: the right page for somebody who *does* have an
 * account and just tapped "Sign in".
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  return authRouteData(request, context, "sign-in");
}

export default function Login({ loaderData }: Route.ComponentProps) {
  return <AuthPage mode="sign-in" {...loaderData} />;
}
