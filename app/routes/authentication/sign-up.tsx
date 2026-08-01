import type { Route } from "./+types/sign-up";
import { AuthPage } from "./components/auth-page";
import { authRouteData } from "./auth-route";

export const handle = { i18n: ["auth"] };

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data?.title ?? "Flappyboard" },
  { name: "description", content: data?.description ?? "" },
];

/**
 * The destination of a pairing arrival — `/login` redirects here when `next`
 * carries a device code (see that file). Nothing redirects back out, so there is
 * no loop to look for.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  return authRouteData(request, context, "sign-up");
}

export default function SignUp({ loaderData }: Route.ComponentProps) {
  return <AuthPage mode="sign-up" {...loaderData} />;
}
