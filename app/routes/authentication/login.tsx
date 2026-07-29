import type { Route } from "./+types/login";
import { LoginForm } from "./components/login-form";
import { AuthShell } from "./components/auth-shell";
import { redirectIfAuthenticated, safeNextPath } from "@/lib/session";

export const handle = { i18n: ["auth"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  // An already-signed-in visitor skips the form and goes straight to where the
  // `next` param (validated — never off-origin) was taking them.
  const next = safeNextPath(new URL(request.url).searchParams.get("next"));
  await redirectIfAuthenticated(request, context, next ?? "/dashboard");
  return {};
}

export default function Login() {
  return (
    <AuthShell>
      <LoginForm />
    </AuthShell>
  );
}
