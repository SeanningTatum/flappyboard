import { useTranslation } from "react-i18next";
import { useOutletContext, Link } from "react-router";
import {
  IconShieldLock,
  IconLayoutDashboard,
  IconCloudUpload,
  IconAtom,
  IconSparkles,
  IconBook,
  IconBrandGithub,
  IconDeviceTv,
} from "@tabler/icons-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StackBadge } from "@/components/stack-badge";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { FeatureCard } from "@/components/feature-card";

// `boards` alongside `dashboard`: the board entry point below is the only copy
// on this page that belongs to the boards feature, so it reads its own namespace
// rather than duplicating strings into `dashboard.json`.
export const handle = { i18n: ["dashboard", "boards"] };

export default function DashboardIndex() {
  const { t } = useTranslation("dashboard");
  const { t: tBoards } = useTranslation("boards");
  const { user } = useOutletContext<{ user: { name: string; role?: string | null } }>();
  const isAdmin = user.role === "admin";

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 lg:px-6">
      {/* Welcome */}
      <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-3">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <IconSparkles className="size-3" />
            {t("eyebrow")}
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("welcome", { name: user.name })}
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Button asChild variant="outline" size="sm" data-testid="dashboard-go-admin">
              <Link to="/admin">
                <IconLayoutDashboard className="size-4" />
                {t("actions.open_admin")}
              </Link>
            </Button>
          )}
          <Button asChild variant="outline" size="sm" data-testid="dashboard-docs">
            <a href="https://github.com/" target="_blank" rel="noreferrer">
              <IconBook className="size-4" />
              {t("actions.docs")}
            </a>
          </Button>
          <LanguageSwitcher compact />
          <ThemeToggle />
        </div>
      </header>

      {/* Boards — the product itself, not part of the boilerplate tour below */}
      <section className="mb-12">
        <Card data-testid="dashboard-boards-panel" className="border-primary/30">
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                <IconDeviceTv className="size-5" />
              </span>
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-semibold tracking-tight">
                  {tBoards("dashboard.title")}
                </h2>
                <p className="max-w-md text-sm text-muted-foreground">
                  {tBoards("dashboard.description")}
                </p>
              </div>
            </div>
            {/*
              Two actions, because there are two ways in. A fresh account starts
              at the boards list; someone standing in front of a TV that is
              already showing a code needs `/link` directly and should not have
              to guess the URL from the couch.
            */}
            <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
              <Button asChild variant="outline" size="sm">
                <Link to="/link" data-testid="dashboard-link-tv-cta">
                  <IconDeviceTv className="size-4" />
                  {tBoards("dashboard.link_cta")}
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/boards" data-testid="dashboard-boards-cta">
                  {tBoards("dashboard.cta")}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Educational grid */}
      <section className="mb-12">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t("explore.title")}
          </h2>
          <span className="font-mono text-[11px] text-muted-foreground">
            {t("explore.count")}
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
          <FeatureCard
            icon={<IconShieldLock className="size-5" />}
            title={t("explore.cards.auth.title")}
            description={t("explore.cards.auth.description")}
            badges={["Better Auth", "D1"]}
            to="/admin/users"
            disabled={!isAdmin}
            disabledHint={t("explore.cards.auth.admin_only")}
            cta={t("explore.cards.auth.cta")}
            testId="dash-card-auth"
          />
          <FeatureCard
            icon={<IconLayoutDashboard className="size-5" />}
            title={t("explore.cards.admin.title")}
            description={t("explore.cards.admin.description")}
            badges={["tRPC", "Drizzle"]}
            to="/admin"
            disabled={!isAdmin}
            disabledHint={t("explore.cards.admin.admin_only")}
            cta={t("explore.cards.admin.cta")}
            testId="dash-card-admin"
          />
          <FeatureCard
            icon={<IconCloudUpload className="size-5" />}
            title={t("explore.cards.upload.title")}
            description={t("explore.cards.upload.description")}
            badges={["R2", "Workers"]}
            to="/admin/kitchen-sink"
            disabled={!isAdmin}
            disabledHint={t("explore.cards.upload.admin_only")}
            cta={t("explore.cards.upload.cta")}
            testId="dash-card-upload"
          />
          <FeatureCard
            icon={<IconAtom className="size-5" />}
            title={t("explore.cards.effect.title")}
            description={t("explore.cards.effect.description")}
            badges={["Effect TS", "Schema"]}
            to="/admin/kitchen-sink"
            disabled={!isAdmin}
            disabledHint={t("explore.cards.effect.admin_only")}
            cta={t("explore.cards.effect.cta")}
            testId="dash-card-effect"
          />
        </div>
      </section>

      {/* Status / your account */}
      <section>
        <Card data-testid="dashboard-account">
          <CardHeader className="gap-2">
            <CardTitle className="text-base">{t("account.title")}</CardTitle>
            <CardDescription>{t("account.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <StackBadge active>
                {isAdmin ? t("account.role_admin") : t("account.role_user")}
              </StackBadge>
              <StackBadge>{t("account.session_active")}</StackBadge>
            </div>
            <Button asChild variant="ghost" size="sm">
              <a
                href="https://github.com/"
                target="_blank"
                rel="noreferrer"
                className="text-sm text-muted-foreground hover:text-foreground"
                data-testid="dashboard-source"
              >
                <IconBrandGithub className="size-4" />
                {t("account.source")}
              </a>
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
