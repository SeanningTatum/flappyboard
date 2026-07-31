import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { IconDeviceMobile } from "@tabler/icons-react";

import { api } from "@/trpc/client";
import { cn } from "@/lib/utils";
import { isValidBoardName, normalizeBoardName } from "@/lib/schemas/boards";
import {
  MAX_DEVICE_NAME_LENGTH,
  lastSeenKey,
} from "@/lib/board/paired-devices";
import {
  CONSOLE,
  ConsoleLabel,
  ConsoleReadout,
  PLATE_LIP,
  WELL_LIP,
} from "@/components/board/console";
import { ConsoleAddress } from "@/components/board/console-address";

/**
 * The controller's second tab: everything about *this board* that is not its
 * message.
 *
 * It absorbs the whole of the old `/boards` management page — the TV address,
 * the rename dialog, the delete dialog, both revoke dialogs and the paired
 * device list — for the reason the owner gave when the plan was reviewed:
 *
 * > "maybe we should have 2 tabs, 1 for the board settings and 1 for the
 * > content"
 *
 * That is a better home than a separate `/boards/:boardId` page, and not only
 * because it is one fewer route. Every control here is about the screen you are
 * currently holding the remote for, and the old page made you leave the thing
 * you were configuring in order to configure it.
 *
 * ## Authority
 *
 * Every write is a tRPC mutation, and every one of them is `protectedProcedure`
 * + `requireOwnedBoard` on the server — so the owner gate is not the `owner`
 * prop, it is the procedure. The prop decides what to *render*: a family phone
 * holding a controller grant has no session at all, so showing it a rename field
 * would be offering a control that can only fail. It gets the one thing it can
 * legitimately change (what this phone is called) and a sentence saying who owns
 * the rest.
 *
 * ## Why the destructive controls are not `AlertDialog`s
 *
 * They were, on `/boards`. A Radix dialog portals to `document.body`, traps
 * focus and positions against the viewport — three behaviours that are fine on a
 * desktop management page and wrong on a phone held one-handed in a dim room,
 * where the confirm button lands wherever the viewport decides. Each destructive
 * key here arms in place instead: one tap turns it into a confirm/cancel pair,
 * in the same spot, at the same size. The two-step is preserved (nothing
 * irreversible happens on a single tap); what is dropped is the overlay.
 *
 * The three revocations stay three separate controls with three separate
 * sentences, because confusing them is the difference between "un-pair the guest
 * who went home" and "make my whole family re-scan":
 *
 * - **Un-pair, per row** — one phone stops working, nobody else notices.
 * - **Un-pair every phone** — all controller grants at once (`grantEpoch`).
 * - **Un-pair all TVs** — every television, and no phone (`deviceEpoch`).
 */

export interface ControllerSettingsProps {
  readonly boardId: string;
  readonly boardName: string;
  /** True for the owner's own signed-in browser; false for a grant. */
  readonly owner: boolean;
  /** What the room calls this device — `null` for the owner and the unnamed. */
  readonly deviceName: string | null;
  /** Absolute URL a television should be pointed at to show this board. */
  readonly displayUrl: string;
}

/* -------------------------------------------------------------------------- */
/* Shared console vocabulary                                                  */
/* -------------------------------------------------------------------------- */

const PLATE = "flex flex-col gap-3 px-3 py-3";
const PLATE_STYLE = {
  backgroundColor: CONSOLE.panel,
  boxShadow: PLATE_LIP,
} as const;

/** The one action treatment: off-white plate, dark ink, square, 44px. */
const INK_KEY =
  "flex min-h-11 shrink-0 touch-manipulation items-center justify-center px-4 text-[11px] font-medium uppercase disabled:opacity-40";
const INK_KEY_STYLE = {
  backgroundColor: CONSOLE.ink,
  color: CONSOLE.panel,
  letterSpacing: "0.14em",
  boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.25)",
} as const;

/** A key that does something you cannot undo. Outlined, never filled amber. */
const EDGE_KEY =
  "flex min-h-11 touch-manipulation items-center justify-center px-4 text-[11px] font-medium uppercase disabled:opacity-40";
const edgeKeyStyle = (destructive: boolean) =>
  ({
    color: destructive ? "var(--destructive, #e5484d)" : CONSOLE.inkDim,
    letterSpacing: "0.16em",
    boxShadow: `inset 0 0 0 1px ${
      destructive ? "var(--destructive, #e5484d)" : CONSOLE.hairline
    }`,
  }) as const;

const WELL_INPUT =
  "h-11 w-full rounded-[2px] border-0 px-3 text-base placeholder:text-[#5a5a5c] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[#ffcc00]";
const WELL_INPUT_STYLE = {
  backgroundColor: CONSOLE.well,
  boxShadow: WELL_LIP,
  color: CONSOLE.ink,
} as const;

/**
 * A destructive control that arms in place.
 *
 * Renders one key; a tap swaps it for a confirm/cancel pair *in the same slot*,
 * so the thing under the thumb never moves to somewhere the thumb has to travel.
 * The consequence sentence is only shown once armed — before that it would be
 * six paragraphs of warning about things nobody has asked to do yet.
 */
function ArmedKey({
  label,
  armedLabel,
  cancelLabel,
  consequence,
  pending,
  pendingLabel,
  onConfirm,
  testId,
}: {
  readonly label: string;
  readonly armedLabel: string;
  readonly cancelLabel: string;
  readonly consequence: string;
  readonly pending: boolean;
  readonly pendingLabel: string;
  readonly onConfirm: () => void;
  readonly testId: string;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        className={EDGE_KEY}
        style={edgeKeyStyle(true)}
        onClick={() => setArmed(true)}
        data-testid={testId}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`${testId}-armed`}>
      <p
        className="text-[12px] leading-relaxed"
        style={{ color: CONSOLE.inkDim }}
        role="alert"
      >
        {consequence}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className={cn(EDGE_KEY, "flex-1")}
          style={edgeKeyStyle(false)}
          onClick={() => setArmed(false)}
          disabled={pending}
          data-testid={`${testId}-cancel`}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={cn(EDGE_KEY, "flex-1")}
          style={edgeKeyStyle(true)}
          onClick={onConfirm}
          disabled={pending}
          data-testid={`${testId}-confirm`}
        >
          {pending ? pendingLabel : armedLabel}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function ControllerSettings({
  boardId,
  boardName,
  owner,
  deviceName,
  displayUrl,
}: ControllerSettingsProps) {
  const { t } = useTranslation("boards");
  const navigate = useNavigate();
  const utils = api.useUtils();

  /* ---------------------------------------------------------------- naming */

  const [name, setName] = useState(boardName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  const rename = api.board.rename.useMutation({
    onSuccess: () => {
      setNameSaved(true);
      setNameError(null);
    },
    onError: () => setNameError(t("rename.error.rename_failed")),
  });

  const saveName = () => {
    const trimmed = normalizeBoardName(name);
    if (trimmed === undefined) {
      setNameError(t("rename.error.name_empty"));
      return;
    }
    if (!isValidBoardName(trimmed)) {
      setNameError(t("rename.error.name_too_long", { max: 60 }));
      return;
    }
    setNameSaved(false);
    setNameError(null);
    rename.mutate({ boardId, name: trimmed });
  };

  /* ------------------------------------------------------- this phone's name */

  const [thisDevice, setThisDevice] = useState(deviceName ?? "");
  const [deviceSaved, setDeviceSaved] = useState(false);
  const nameDevice = api.board.nameDevice.useMutation({
    onSuccess: () => setDeviceSaved(true),
  });

  /* ------------------------------------------------------------- the devices */

  // Owner-only: `pairedDevices` is a `protectedProcedure`, so a grant would get
  // a 401 back and a permanently-loading list.
  const devices = api.board.pairedDevices.useQuery(
    { boardId },
    { enabled: owner }
  );

  const afterRevoke = () => void utils.board.pairedDevices.invalidate();

  const revokeDevice = api.board.revokeDevice.useMutation({
    onSuccess: afterRevoke,
  });
  const revokeControllers = api.board.revokeControllers.useMutation({
    onSuccess: afterRevoke,
  });
  const revokeDisplays = api.board.revokeDevices.useMutation({
    onSuccess: afterRevoke,
  });

  /* -------------------------------------------------------------- the board */

  const deleteBoard = api.board.delete.useMutation({
    // The board this page is *about* no longer exists, so there is nothing to
    // render here. The rack is the only honest destination.
    onSuccess: () => navigate("/boards"),
  });

  const deviceList = devices.data ?? [];

  return (
    <div className="flex flex-col gap-6 pb-4" data-testid="control-settings">
      {/* ------------------------------------------------ the TV address */}
      <section className="flex flex-col gap-2">
        <ConsoleLabel>{t("controller.settings.display.title")}</ConsoleLabel>
        <div className={PLATE} style={PLATE_STYLE}>
          <p className="text-[12px] leading-relaxed" style={{ color: CONSOLE.inkDim }}>
            {t("controller.settings.display.description")}
          </p>
          <ConsoleAddress
            url={displayUrl}
            data-testid="control-settings-address"
          />
        </div>
      </section>

      {/* ------------------------------------------------------ this phone */}
      {!owner && (
        <section className="flex flex-col gap-2">
          <ConsoleLabel>{t("controller.settings.thisDevice.title")}</ConsoleLabel>
          <div className={PLATE} style={PLATE_STYLE}>
            <p
              className="text-[12px] leading-relaxed"
              style={{ color: CONSOLE.inkDim }}
            >
              {t("controller.settings.thisDevice.description")}
            </p>
            <div className="flex items-stretch gap-2">
              <input
                value={thisDevice}
                onChange={(event) => {
                  setThisDevice(event.target.value);
                  setDeviceSaved(false);
                }}
                // Words, not characters: this prints in the owner's device list
                // verbatim — the board's own uppercase folding does not apply.
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                maxLength={MAX_DEVICE_NAME_LENGTH}
                placeholder={t("controller.settings.thisDevice.placeholder")}
                className={WELL_INPUT}
                style={WELL_INPUT_STYLE}
                data-testid="control-settings-device-name"
              />
              <button
                type="button"
                className={INK_KEY}
                style={INK_KEY_STYLE}
                disabled={
                  nameDevice.isPending || thisDevice.trim().length === 0
                }
                onClick={() =>
                  nameDevice.mutate({ boardId, name: thisDevice.trim() })
                }
                data-testid="control-settings-device-name-save"
              >
                {nameDevice.isPending
                  ? t("controller.settings.name.saving")
                  : t("controller.settings.name.save")}
              </button>
            </div>
            {deviceSaved && (
              <p
                role="status"
                className="text-[11px] font-medium uppercase"
                style={{ color: CONSOLE.inkMute, letterSpacing: "0.14em" }}
              >
                {t("controller.settings.name.saved")}
              </p>
            )}
          </div>
        </section>
      )}

      {!owner && (
        <p className="px-1 text-[12px]" style={{ color: CONSOLE.inkMute }}>
          {t("controller.settings.ownerOnly")}
        </p>
      )}

      {owner && (
        <>
          {/* ------------------------------------------------ board name */}
          <section className="flex flex-col gap-2">
            <ConsoleLabel>{t("controller.settings.name.title")}</ConsoleLabel>
            <div className={PLATE} style={PLATE_STYLE}>
              <div className="flex items-stretch gap-2">
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameSaved(false);
                  }}
                  aria-label={t("controller.settings.name.label")}
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    saveName();
                  }}
                  className={WELL_INPUT}
                  style={WELL_INPUT_STYLE}
                  data-testid="control-settings-board-name"
                />
                <button
                  type="button"
                  className={INK_KEY}
                  style={INK_KEY_STYLE}
                  disabled={rename.isPending || name.trim() === boardName}
                  onClick={saveName}
                  data-testid="control-settings-board-name-save"
                >
                  {rename.isPending
                    ? t("controller.settings.name.saving")
                    : t("controller.settings.name.save")}
                </button>
              </div>
              {nameError !== null && (
                <p
                  role="alert"
                  className="text-[12px] text-destructive"
                  data-testid="control-settings-board-name-error"
                >
                  {nameError}
                </p>
              )}
              {nameSaved && nameError === null && (
                <p
                  role="status"
                  className="text-[11px] font-medium uppercase"
                  style={{ color: CONSOLE.inkMute, letterSpacing: "0.14em" }}
                >
                  {t("controller.settings.name.saved")}
                </p>
              )}
            </div>
          </section>

          {/* --------------------------------------------------- devices */}
          <section className="flex flex-col gap-2">
            <ConsoleLabel className="justify-between">
              <span>{t("devices.title")}</span>
              {/*
                The device count, on the controller rather than on the rack —
                the owner's decision, and the right one: a number is only worth
                showing next to the controls that change it.
              */}
              <ConsoleReadout
                label={t("devices.title")}
                value={deviceList.length}
              />
            </ConsoleLabel>
            <div className={PLATE} style={PLATE_STYLE}>
              {deviceList.length === 0 ? (
                <p
                  className="text-[12px] leading-relaxed"
                  style={{ color: CONSOLE.inkDim }}
                  data-testid="control-settings-devices-empty"
                >
                  {t("devices.empty")}
                </p>
              ) : (
                <ul className="flex flex-col">
                  {deviceList.map((device) => {
                    const seen = lastSeenKey(device.lastSeenAt, Date.now());
                    return (
                      <li
                        key={device.nonce}
                        className="flex items-center gap-3 py-2"
                        style={{ boxShadow: `inset 0 -1px 0 ${CONSOLE.hairline}` }}
                        data-testid="control-settings-device"
                      >
                        <IconDeviceMobile
                          aria-hidden
                          className="size-4 shrink-0"
                          style={{ color: CONSOLE.inkMute }}
                        />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span
                            className="truncate text-[13px]"
                            style={{ color: CONSOLE.ink }}
                          >
                            {device.name ?? t("devices.unnamed")}
                          </span>
                          <span
                            className="text-[11px]"
                            style={{ color: CONSOLE.inkMute }}
                          >
                            {t("devices.lastSeen", {
                              when: t(seen.key, { count: seen.count }),
                            })}
                          </span>
                        </div>
                        <button
                          type="button"
                          className={EDGE_KEY}
                          style={edgeKeyStyle(false)}
                          disabled={revokeDevice.isPending}
                          onClick={() =>
                            revokeDevice.mutate({
                              boardId,
                              nonce: device.nonce,
                            })
                          }
                          data-testid="control-settings-device-unpair"
                        >
                          {revokeDevice.isPending
                            ? t("devices.unpairing")
                            : t("devices.unpair")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* ------------------------------------------------- the edge */}
          <section className="flex flex-col gap-2">
            <ConsoleLabel>{t("controller.settings.danger.title")}</ConsoleLabel>
            <div className={PLATE} style={PLATE_STYLE}>
              <ArmedKey
                label={t("devices.unpairDisplays")}
                armedLabel={t("devices.unpairDisplaysConfirm")}
                cancelLabel={t("revoke.cancel")}
                consequence={t("devices.unpairDisplaysBody")}
                pending={revokeDisplays.isPending}
                pendingLabel={t("devices.unpairing")}
                onConfirm={() => revokeDisplays.mutate({ boardId })}
                testId="control-settings-unpair-displays"
              />
              <ArmedKey
                label={t("revoke.confirm")}
                armedLabel={t("revoke.confirm")}
                cancelLabel={t("revoke.cancel")}
                consequence={t("revoke.description")}
                pending={revokeControllers.isPending}
                pendingLabel={t("revoke.revoking")}
                onConfirm={() => revokeControllers.mutate({ boardId })}
                testId="control-settings-revoke"
              />
              <ArmedKey
                label={t("delete.confirm")}
                armedLabel={t("delete.confirm")}
                cancelLabel={t("delete.cancel")}
                consequence={t("delete.description")}
                pending={deleteBoard.isPending}
                pendingLabel={t("delete.deleting")}
                onConfirm={() => deleteBoard.mutate({ boardId })}
                testId="control-settings-delete"
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
