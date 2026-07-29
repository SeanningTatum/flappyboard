# Recipe: Put a board on a Samsung TV (built-in browser)

> Ops runbook for the owner, not a code recipe. The runtime is the TV's built-in
> **Internet** app (Tizen) — chosen in plan `plans/2026-07-28-tv-living-room.html`
> decision 2, against the kiosk-stick recommendation. That choice caps what
> software can do; this recipe is the manual half of the feature.
>
> Menu names below are Tizen 6/7/8 (2021–2024 models) and drift between model
> years — when a label differs, look for the nearest synonym rather than
> abandoning the step.

## What to expect (read before starting)

- **No autostart.** After a power cycle, someone opens the Internet app by hand.
  Setting flappyboard as the browser's start page makes that one remote press
  land on the board.
- **Browser chrome may stay visible.** Tizen's Internet app does not always
  offer a true kiosk mode. Accepted — the board is designed to read fine under
  an address bar.
- **Cookies get evicted.** The TV browser evicts storage aggressively. When it
  does, the board redirects to `/tv` and shows a pairing code — re-pairing is
  two taps on a phone (below), never typing on the TV.
- **Wake lock is best-effort.** The board tries the Wake Lock API and falls
  back to a silent looping video; Tizen may honour neither. If the TV sleeps,
  its own **Settings → General → System Manager → Auto Power Off / Sleep
  Timer** is the knob — turn both OFF for a wall board.

## One-time setup

1. On the TV, open the **Internet** app.
2. Go to the board's URL: `https://<your-host>/tv`. A 6-character pairing code
   appears and stays on screen.
3. On your phone (already signed in), open `https://<your-host>/link`, enter
   the code, pick the board. The TV flips to the board within a second or two —
   approval is pushed over the socket, no refresh needed.
4. Back on the TV: press the remote's **OK** once. That single gesture does two
   jobs — unlocks sound and requests fullscreen (see kiosk-display's "one
   gesture, two jobs"). If fullscreen is refused, chrome stays; that is not a
   failure.
5. Make it the start page: Internet app → **Settings → General → Start page /
   Homepage** → enter the board URL (`/b/<boardId>`, copied from the address
   bar now that it is paired — the URL is clean, no token in it).
6. Disable display sleep: TV **Settings → General → System Manager** →
   **Auto Power Off** OFF, **Sleep Timer** OFF. (Menu path varies most here.)

## Daily life

- **Leave it.** The board renews nothing and needs nothing while the socket is
  live. Pixel drift and the 23:00–07:00 idle dim run on their own; do not
  "fix" them — they are the burn-in protection.
- **Socket drops**: the board shows a dim scrim over the last message and
  hard-reloads itself once if the socket stays dead past 2 minutes. If the
  message is still right, nothing is wrong.
- **Board shows a pairing code again** → the TV evicted the cookie. Phone →
  `/link` → enter the code. History and settings survive; only the TV's
  credential was lost.

## Un-pairing

Owner's phone → `/boards` → the board's device list → **Un-pair** on the TV's
row, or **Un-pair TVs** for every display at once. Phones are not affected by
the TV control and vice versa (see the family-grants verification for the
three distinct controls).

## Definition of done for a new TV

- [ ] Board visible on the TV, reached via `/tv` + phone approval (no password
      ever typed on the TV)
- [ ] One OK press spent (sound + fullscreen attempted)
- [ ] flappyboard set as the Internet app's start page
- [ ] Auto Power Off and Sleep Timer off
- [ ] TV appears as a named row in the owner's `/boards` device list
- [ ] (First TV only) the 8h unattended soak + power-cycle cookie-survival
      test from `features/kiosk-display/kiosk-display.md` — the two checks
      that decide whether decision 2 holds
