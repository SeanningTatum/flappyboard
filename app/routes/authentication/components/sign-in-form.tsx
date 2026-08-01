import { useState } from "react";
import { useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { authClient } from "@/auth/client";
import { effectResolver } from "@/lib/effect-form";
import { LoginSchema, type LoginInput } from "@/lib/schemas/auth";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { AuthError, FIELD_CLASS, authErrorMessage } from "./auth-form-parts";

/**
 * The sign-in half of the merged auth surface. The `login-*` test ids are kept
 * verbatim from the page this replaced — `e2e/auth.spec.ts` drives them, and so
 * does `scripts/design-audit.ts`'s own `--sign-in` step, which signs in through
 * this exact form rather than through an API call.
 */
export function SignInForm({ next }: { readonly next: string | null }) {
  const navigate = useNavigate();
  const [authError, setAuthError] = useState<string>();
  const { t } = useTranslation("auth");

  const form = useForm<LoginInput>({
    resolver: effectResolver(LoginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(data: LoginInput) {
    setAuthError(undefined);

    try {
      const result = await authClient.signIn.email({
        email: data.email,
        password: data.password,
      });

      if (result.error) {
        setAuthError(
          authErrorMessage(result.error, t, "errors.sign_in_failed")
        );
        return;
      }

      // `/`, not `/dashboard` — that route is gone. The index is what resolves
      // where a session actually belongs (`resolveSignedInHome`), and it is the
      // only place that knows.
      navigate(next ?? "/");
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : t("errors.sign_in_failed")
      );
    }
  }

  return (
    <Form {...form}>
      {/*
        `method="post"` is a security control, not a formality. A <form>
        defaults to GET, so before hydration (or if the JS bundle fails to load)
        a submit navigates to `?email=…&password=…` — putting the password in
        the URL, browser history and any onward Referer. This was observed for
        real during phase 3 verification when Vite served a stale dep bundle and
        the page never hydrated. POST keeps the credentials in the request body
        whatever happens to the JS.
      */}
      <form
        method="post"
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-5"
        data-testid="login-form"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("sign_in.email_label")}</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder={t("sign_in.email_placeholder")}
                  className={FIELD_CLASS}
                  data-testid="login-email"
                  {...field}
                  disabled={form.formState.isSubmitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("sign_in.password_label")}</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="current-password"
                  className={FIELD_CLASS}
                  data-testid="login-password"
                  {...field}
                  disabled={form.formState.isSubmitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/*
          There was a "Forgot password?" link here and it pointed at `href="#"`.
          There is no password-reset route in this app, so the link was a
          promise the product cannot keep — worse than its absence, because a
          visitor who taps it learns nothing and loses their place. Removed
          rather than re-pointed; recorded as unresolved.
        */}

        <AuthError message={authError} testId="login-error" />

        <Button
          type="submit"
          className="h-12 w-full px-6 text-base font-medium"
          data-testid="login-submit"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting
            ? t("sign_in.submitting")
            : t("sign_in.submit")}
        </Button>
      </form>
    </Form>
  );
}
