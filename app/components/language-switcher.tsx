import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { supportedLngs } from "@/i18n";
import { cn } from "@/lib/utils";

const languageLabels: Record<string, string> = {
  en: "English",
  zh: "中文",
};

/**
 * What the trigger says in `compact` mode. The menu still lists the full names —
 * this is only the closed state, where there is room for a tag and not a word.
 */
const compactLabels: Record<string, string> = {
  en: "EN",
  zh: "中文",
};

interface LanguageSwitcherProps {
  className?: string;
  /** Compact pill suitable for top bars. Defaults to false (wide select). */
  compact?: boolean;
}

/**
 * Locale toggle. SSR detects locale via cookie/header in
 * `app/i18n/i18n.server.ts`; this component drives the swap by submitting
 * to the `/api/set-locale` action via `useFetcher`. That:
 *   1. Sets the persistent locale cookie (server-owned encoding — see
 *      `app/routes/api/set-locale.ts`) so future SSR requests honor it.
 *   2. Triggers React Router's automatic loader revalidation, so the root
 *      loader re-detects locale and `useChangeLanguage(loaderData.locale)`
 *      in `app/root.tsx` flips the live i18next instance.
 *
 * No full reload, no manual `i18n.changeLanguage` call — relying on the
 * existing root-level binding keeps the component idempotent and avoids
 * fighting with `useChangeLanguage`'s revert-on-mismatch effect.
 */
export function LanguageSwitcher({
  className,
  compact = false,
}: LanguageSwitcherProps = {}) {
  const { i18n } = useTranslation();
  const fetcher = useFetcher();
  const pending = fetcher.state !== "idle";

  function handleLanguageChange(newLng: string) {
    if (newLng === i18n.language || pending) return;
    fetcher.submit(
      { lng: newLng },
      { method: "post", action: "/api/set-locale" },
    );
  }

  return (
    <Select value={i18n.language} onValueChange={handleLanguageChange} disabled={pending}>
      <SelectTrigger
        className={cn(
          // `shrink-0` on the value is load-bearing, not tidying. `SelectTrigger`
          // styles its value slot with `line-clamp-1` *and* `flex`; the `flex`
          // wins the `display` cascade, which strips `-webkit-box` and leaves
          // `overflow: hidden` on a flex item that is free to shrink. In a
          // `w-auto` trigger it collapsed to **6px** — the label read "English"
          // in the DOM and painted a single "E" on the landing page and both
          // auth pages. Measured, not inferred.
          "*:data-[slot=select-value]:shrink-0",
          // `data-[size=default]:h-11`, not `h-11`. `SelectTrigger`'s base sets
          // its height behind a `data-[size=default]:` variant, which outranks
          // a plain utility on specificity — and tailwind-merge does not dedupe
          // across a variant boundary, so a caller passing `h-11` silently got
          // 36px. Measured at 44×36 on both the landing page and the auth
          // pages, under the 44px floor the phone-first constraint sets.
          // `compact` is the utility-corner variant, and its peer there is the
          // theme toggle — a bare ghost icon button. This used to be a bordered
          // box beside it at a different optical height: two peer controls, two
          // treatments (`design-critic`, P3-a). Bare now, same 44px box, same
          // hover fill as `Button variant="ghost"`.
          //
          // The border goes and the focus indicator does not: the global
          // `:focus-visible` outline in `app.css` is what marks this control,
          // which is why `ui/select.tsx` had `outline-none` removed and why it
          // must never come back.
          compact
            ? "h-11 w-auto gap-1 border-0 bg-transparent px-2.5 text-xs shadow-none hover:bg-accent hover:text-accent-foreground data-[size=default]:h-11 dark:bg-transparent dark:hover:bg-accent"
            : "w-[140px]",
          className,
        )}
        data-testid="language-switcher"
      >
        <SelectValue>
          {compact
            ? (compactLabels[i18n.language] ?? i18n.language.toUpperCase())
            : (languageLabels[i18n.language] ?? i18n.language)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {supportedLngs.map((lng) => (
          <SelectItem key={lng} value={lng}>
            {languageLabels[lng] ?? lng}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
