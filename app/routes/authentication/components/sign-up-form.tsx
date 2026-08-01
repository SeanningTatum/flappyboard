import { useState } from "react";
import { useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { authClient } from "@/auth/client";
import { effectResolver } from "@/lib/effect-form";
import { SignupSchema, type SignupInput } from "@/lib/schemas/auth";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { AuthError, FIELD_CLASS, authErrorMessage } from "./auth-form-parts";

/**
 * The account-creation half of the merged auth surface. `signup-*` test ids kept
 * verbatim — `e2e/auth.spec.ts` drives them.
 */
export function SignUpForm({ next }: { readonly next: string | null }) {
  const navigate = useNavigate();
  const [authError, setAuthError] = useState<string>();
  const { t } = useTranslation("auth");

  const form = useForm<SignupInput>({
    resolver: effectResolver(SignupSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
  });

  async function onSubmit(data: SignupInput) {
    setAuthError(undefined);

    try {
      const result = await authClient.signUp.email({
        email: data.email,
        password: data.password,
        name: data.name,
      });

      if (result.error) {
        setAuthError(
          authErrorMessage(result.error, t, "errors.sign_up_failed")
        );
        return;
      }

      // `/`, not `/dashboard` — see the note in `sign-in-form.tsx`.
      navigate(next ?? "/");
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : t("errors.sign_up_failed")
      );
    }
  }

  return (
    <Form {...form}>
      {/*
        `method="post"` is a security control — see the note in
        `sign-in-form.tsx`. A GET fallback on an unhydrated page would put the
        new account's password in the URL and browser history.
      */}
      <form
        method="post"
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-5"
        data-testid="signup-form"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("sign_up.name_label")}</FormLabel>
              <FormControl>
                <Input
                  autoComplete="name"
                  placeholder={t("sign_up.name_placeholder")}
                  className={FIELD_CLASS}
                  data-testid="signup-name"
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
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("sign_up.email_label")}</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder={t("sign_up.email_placeholder")}
                  className={FIELD_CLASS}
                  data-testid="signup-email"
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
              <FormLabel>{t("sign_up.password_label")}</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="new-password"
                  className={FIELD_CLASS}
                  data-testid="signup-password"
                  {...field}
                  disabled={form.formState.isSubmitting}
                />
              </FormControl>
              <FormDescription className="text-text-body-subtle">
                {t("sign_up.password_hint")}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("sign_up.confirm_password_label")}</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="new-password"
                  className={FIELD_CLASS}
                  data-testid="signup-confirm-password"
                  {...field}
                  disabled={form.formState.isSubmitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <AuthError message={authError} testId="signup-error" />

        <Button
          type="submit"
          className="h-12 w-full px-6 text-base font-medium"
          data-testid="signup-submit"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting
            ? t("sign_up.submitting")
            : t("sign_up.submit")}
        </Button>
      </form>
    </Form>
  );
}
