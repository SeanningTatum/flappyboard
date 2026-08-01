import * as React from "react"

import { cn } from "@/lib/utils"

/*
 * `outline-none` removed from the base class — the same defect `button.tsx` had,
 * missed when that one was fixed.
 *
 * It emits `outline-style: none`, which kills the global `:focus-visible`
 * outline in `app.css` AND the forced-colors fallback under it. What is left is
 * `focus-visible:ring-*`, a `box-shadow` — and any component that sets its own
 * inline `box-shadow` overwrites it. That is exactly what the controller's six
 * typing wells do (they carry `WELL_LIP` inline), so **every text row on the
 * phone had no focus indicator at all**: measured `outline: 0px none` with a
 * box-shadow containing only the well lip. Login and sign-up were in the same
 * state.
 *
 * Verified by keyboard walk after the colour transition settles, not by reading
 * computed style on the frame Tab lands — `transition-colors` includes
 * `outline-color` in Tailwind v4, so an immediate read shows `currentColor`
 * mid-fade and invents defects that are not there.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
