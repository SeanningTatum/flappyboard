import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { IconChevronRight } from "@tabler/icons-react";

import type { Route } from "./+types/_index";
import { requireSession } from "@/lib/session";
import {
  CONSOLE,
  ConsoleField,
  PLATE_LIP,
} from "@/components/board/console";
import { ConsoleAddress } from "@/components/board/console-address";
import { ConsoleShell } from "@/components/board/console-shell";
import { FlapWord, nameplatePigment } from "@/components/board/flap-word";
// The scoped token override for the console surfaces. See the header of that
// file for why this route runs its own visual language.
import "../board/hardware-theme.css";

/**
 * `/boards` — the rack.
 *
 * It used to be a board *manager*: a create form, a card per board carrying its
 * TV address, a rename dialog, a delete dialog, two revoke dialogs and a device
 * list — 560 lines and six actions. All of that has moved to the controller's
 * Settings tab, because of the decision that shaped this whole redesign: **a
 * board is a television.** You do not create one and then go looking for a
 * screen to put it on; you point a screen at `/tv`, and the board it needs
 * comes into existence behind you.
 *
 * What is left is the only question this page can still legitimately ask —
 * *which screen?* — and the answer to the only question a household with no
 * screens yet has: *what do I type into the TV?*
 *
 * A single-board household never sees this page in normal use: `/` sends them
 * straight to their controller (`resolveSignedInHome`). It is a switcher, and a
 * switcher with one entry is a stop sign.
 *
 * ## Why it is dressed as hardware
 *
 * Every other signed-in surface — the TV, the controller, pairing — is the
 * object's own console, and this one was a white card-and-shadow web page one
 * tap away from all of them. The design review's finding was blunt and correct:
 * the two halves did not read as one product. So the rack runs the same scoped
 * token override the console routes do, and each board wears its name in real
 * flaps, in a pigment derived from its id — which is also the first place in the
 * product where the eight measured pigments are actually spent.
 */

export const handle = { i18n: ["boards"] };

/** Dark console, like everything it switches between. */
export const meta: Route.MetaFunction = () => [
  { name: "color-scheme", content: "dark" },
  { name: "theme-color", content: CONSOLE.field },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const session = await requireSession(request, context);

  const url = new URL(request.url);
  const boards = await context.trpc.board.list();

  /*
    Paired devices are NOT read here any more.

    They used to be — one Durable Object round trip per board, in parallel, to
    print a device list on every card. The count now lives on the controller,
    next to the un-pair controls that act on it, which is the only place it is
    ever actionable. That removes N round trips from the one page a household
    opens while standing up, and it removes the failure mode where an unreachable
    room made a board look like it had lost its phones.
  */
  return {
    boards: boards.map((board) => ({
      id: board.id,
      name: board.name,
      revision: board.revision,
    })),
    // The TV needs a host, not a path — taken from the request so it is right on
    // localhost, preview and production without a configured base URL.
    pairingUrl: `${url.origin}/tv`,
    user: {
      name: session.user.name,
      isAdmin: session.user.role === "admin",
    },
  };
}

/**
 * Nameplate flap width. Fixed px rather than `vmin`: this is read at arm's
 * length on a phone, unlike the TV's own flaps, and the rack must not resize
 * itself when the phone is turned on its side. 14 × 18 = 252px, which clears a
 * 390px viewport with the chevron and the plate's padding beside it.
 */
const NAMEPLATE_CELL = "14px";

/** How many flaps a nameplate is wide. Longer names clip, exactly like a board. */
const NAMEPLATE_CELLS = 18;

export default function BoardsIndex({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("boards");
  const { boards, pairingUrl, user } = loaderData;

  return (
    <ConsoleField data-testid="boards-root" className="gap-6">
      <ConsoleShell userName={user.name} isAdmin={user.isAdmin} />

      <header className="flex flex-col gap-1.5 px-1">
        <h1
          className="text-[13px] font-medium uppercase"
          style={{ color: CONSOLE.ink, letterSpacing: "0.18em" }}
        >
          {t("title")}
        </h1>
        <p className="text-[13px] leading-relaxed" style={{ color: CONSOLE.inkDim }}>
          {t("subtitle")}
        </p>
      </header>

      {boards.length === 0 ? (
        <section
          className="flex flex-col gap-3 px-3 py-4"
          style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
          data-testid="boards-empty"
        >
          <h2
            className="text-[11px] font-medium uppercase"
            style={{ color: CONSOLE.ink, letterSpacing: "0.16em" }}
          >
            {t("rack.empty.title")}
          </h2>
          <p
            className="text-[13px] leading-relaxed"
            style={{ color: CONSOLE.inkDim }}
          >
            {t("rack.empty.body")}
          </p>
          <ConsoleAddress
            url={pairingUrl}
            label={t("rack.address.label")}
            data-testid="boards-pairing-address"
          />
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-2" data-testid="boards-rack">
            {boards.map((board) => (
              <Link
                key={board.id}
                to={`/b/${encodeURIComponent(board.id)}/c`}
                aria-label={t("rack.open", { name: board.name })}
                data-testid="boards-rack-entry"
                data-board-id={board.id}
                // The whole row is the target — 44px is the floor, not the
                // aim, and a nameplate you can read across a kitchen is a
                // nameplate you can hit without looking.
                className="flex touch-manipulation items-center gap-3 px-3 py-3"
                style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {/*
                    The board says its own name, in its own flaps. This is the
                    identity move: three televisions in a house are three
                    colours before they are three words, and the pigment is
                    derived from the id so it never changes under anyone.
                  */}
                  <FlapWord
                    text={board.name}
                    color={nameplatePigment(board.id)}
                    cellWidth={NAMEPLATE_CELL}
                    cells={NAMEPLATE_CELLS}
                    label={board.name}
                    data-testid="boards-rack-nameplate"
                  />
                  <span
                    className="text-[10px] font-medium uppercase"
                    style={{ color: CONSOLE.inkMute, letterSpacing: "0.16em" }}
                  >
                    {board.revision === 0
                      ? t("rack.never_written")
                      : t("rack.revision", { revision: board.revision })}
                  </span>
                </div>
                <IconChevronRight
                  aria-hidden
                  className="size-5 shrink-0"
                  style={{ color: CONSOLE.inkMute }}
                />
              </Link>
            ))}
          </section>

          {/*
            The way to add the next television, kept below the rack rather than
            behind a "+ New board" key. There is no create action any more — the
            TV creates its own board when it is pointed here — so this is
            genuinely an address and not a disguised button.
          */}
          <section
            className="flex flex-col gap-3 px-3 py-3"
            style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
          >
            <ConsoleAddress
              url={pairingUrl}
              label={t("rack.address.label")}
              data-testid="boards-pairing-address"
            />
            <p className="px-1 text-[12px]" style={{ color: CONSOLE.inkMute }}>
              {t("rack.address.hint")}
            </p>
          </section>
        </>
      )}
    </ConsoleField>
  );
}
