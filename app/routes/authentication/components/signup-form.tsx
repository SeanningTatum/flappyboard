import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Link, useNavigate, useSearchParams } from "react-router"
import { authClient } from "@/auth/client"
import { effectResolver } from "@/lib/effect-form"
import { safeNextPath } from "@/lib/session"
import { useForm } from "react-hook-form"
import { SignupSchema, type SignupInput } from "@/lib/schemas/auth"
import { useState } from "react"
import { useTranslation } from "react-i18next"

interface SignupFormProps extends React.ComponentProps<"div"> { }

export function SignupForm({ className, ...props }: SignupFormProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Where the visitor was headed before we asked them for an account (e.g. a
  // TV-pairing QR scan) — validated, so it can never point off-origin.
  const next = safeNextPath(searchParams.get("next"))
  const [authError, setAuthError] = useState<string>()
  const { t } = useTranslation("auth")

  const form = useForm<SignupInput>({
    resolver: effectResolver(SignupSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
  })

  async function onSubmit(data: SignupInput) {
    setAuthError(undefined)

    try {
      const result = await authClient.signUp.email({
        email: data.email,
        password: data.password,
        name: data.name,
      })

      if (result.error) {
        setAuthError(result.error.message || t("signup.error_failed"))
        return
      }

      navigate(next ?? "/dashboard")
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : t("signup.error_failed"))
    }
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card data-testid="signup-card" className="border-border/80 shadow-sm">
        <CardHeader className="gap-2">
          <CardTitle className="text-xl">{t("signup.title")}</CardTitle>
          <CardDescription>{t("signup.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            {/*
              `method="post"` is a security control — see the note in
              login-form.tsx. A GET fallback on an unhydrated page would put the
              new account's password in the URL and browser history.
            */}
            <form
              method="post"
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-6"
              data-testid="signup-form"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("signup.name_label")}</FormLabel>
                    <FormControl>
                      <Input
                        autoComplete="name"
                        placeholder={t("signup.name_placeholder")}
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
                    <FormLabel>{t("signup.email_label")}</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        autoComplete="email"
                        placeholder={t("signup.email_placeholder")}
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
                    <FormLabel>{t("signup.password_label")}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        data-testid="signup-password"
                        {...field}
                        disabled={form.formState.isSubmitting}
                      />
                    </FormControl>
                    <FormDescription>{t("signup.password_hint")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("signup.confirm_password_label")}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        data-testid="signup-confirm-password"
                        {...field}
                        disabled={form.formState.isSubmitting}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {authError && (
                <div
                  role="alert"
                  data-testid="signup-error"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {authError}
                </div>
              )}
              <div className="space-y-4">
                <Button
                  type="submit"
                  className="w-full"
                  data-testid="signup-submit"
                  disabled={form.formState.isSubmitting}
                >
                  {form.formState.isSubmitting ? t("signup.submitting") : t("signup.submit")}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  {t("signup.has_account")}{" "}
                  <Link
                    to={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
                    className="underline underline-offset-4"
                  >
                    {t("signup.login_link")}
                  </Link>
                </p>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}
