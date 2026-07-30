import type { Route } from "./+types/sign-up";
import { SignupForm } from "./components/signup-form";
import { AuthShell } from "./components/auth-shell";
import { redirectIfAuthenticated, safeNextPath } from "@/lib/session";

export const handle = { i18n: ["auth"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const next = safeNextPath(new URL(request.url).searchParams.get("next"));
  await redirectIfAuthenticated(request, context, next ?? "/dashboard");
  return {};
}

export default function SignUp() {
  return (
    <AuthShell>
      <SignupForm />
    </AuthShell>
  );
}
