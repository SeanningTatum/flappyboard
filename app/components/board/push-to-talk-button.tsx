import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { api } from "@/trpc/client";
import {
  CONSOLE,
  ConsoleLabel,
  ConsoleReadout,
  PLATE_LIP,
  WELL_LIP,
} from "@/components/board/console";
import {
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  formatElapsed,
  pickRecorderMimeType,
  readTranscribeOutcome,
} from "@/lib/board/voice";

/**
 * The walkie-talkie key: hold it, say what the board should say, let go.
 *
 * Two hops behind one press — `/api/transcribe` turns the clip into text, then
 * `board.generate` hands that text to the board writer. The user is told which
 * hop they are on at every moment, because the whole interaction is "I spoke at
 * my phone and then a television in another room changed": if the button goes
 * quiet for two seconds, the only available interpretation is that it did not
 * hear you, and the correct response to that belief is to press it again.
 *
 * ## Hold semantics
 *
 * `pointerdown` starts, and **four** events stop: `pointerup`, `pointercancel`,
 * `pointerleave`, and `lostpointercapture`. Only the first is the happy path.
 * This is used one-handed, standing up, on a phone: a thumb that slides off the
 * button, a call that arrives mid-sentence, or a browser that decides the
 * gesture is a scroll all produce one of the other three — and every one of them
 * has to release the microphone, because a button that is still recording after
 * you stopped touching it is the worst outcome this component can produce.
 *
 * A hard cap (`MAX_RECORDING_MS`) stops it anyway, so even a pointer event lost
 * entirely to the platform cannot leave the mic open. The elapsed readout shows
 * the cap alongside the count so it is never a surprise.
 *
 * ## Voice is an addition, not a replacement
 *
 * If the microphone is refused, this component says so in plain words and
 * *stays out of the way* — `MessageEditor` above it is untouched and fully
 * usable. Nothing here disables or gates the typed path.
 */

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `denied` and `unsupported` are separated from the rest because they are the
 * only two the user cannot fix by pressing again — one needs a permission
 * change, the other needs a different browser. Everything else is "try again",
 * so it shares one shape and differs only in the reason string.
 */
export type VoiceFault =
  | { readonly kind: "denied" }
  | { readonly kind: "unsupported" }
  /**
   * The page is not a secure context, so `navigator.mediaDevices` does not exist
   * at all. Separate from `unsupported` because the remedy is completely
   * different and the wrong message sends people hunting for another browser:
   * this is the everyday case of opening the dev server on a phone over
   * `http://<lan-ip>:5173`, where every browser refuses the microphone.
   */
  | { readonly kind: "insecure" }
  | { readonly kind: "tooShort" }
  | { readonly kind: "mic" }
  /** `reason` is the server's own user-facing copy, or `null` for our generic. */
  | { readonly kind: "transcribe"; readonly reason: string | null }
  | { readonly kind: "generate" };

export type VoicePhase =
  | { readonly step: "idle" }
  | { readonly step: "recording" }
  | { readonly step: "transcribing" }
  | { readonly step: "generating" }
  | { readonly step: "done"; readonly truncated: boolean; readonly repaired: boolean }
  | { readonly step: "error"; readonly fault: VoiceFault };

/** The two steps where a press must not start a second recording. */
const isBusy = (phase: VoicePhase): boolean =>
  phase.step === "recording" ||
  phase.step === "transcribing" ||
  phase.step === "generating";

export interface PushToTalkButtonProps {
  readonly boardId: string;
  /** Advisory — the room is last-write-wins. Same value the editor sends. */
  readonly baseRevision: number;
  /** Another control on the console is mid-write. */
  readonly pending: boolean;
  /** Lets the parent advance its revision cursor from our write. */
  readonly onWritten?: (revision: number) => void;
  readonly className?: string;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function PushToTalkButton({
  boardId,
  baseRevision,
  pending,
  onWritten,
  className,
}: PushToTalkButtonProps) {
  const { t, i18n } = useTranslation("board");
  const utils = api.useUtils();

  const [phase, setPhase] = useState<VoicePhase>({ step: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState<string | null>(null);

  /**
   * Everything a recording owns, in one place so a single `release()` can undo
   * all of it. Refs rather than state: these are cleaned up from event handlers
   * and timers that must not wait for a render.
   */
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Whether the finger is still down. Load-bearing for the race that a phone
   * makes routine: `getUserMedia` takes a moment (longer the first time, when
   * the OS prompt appears), and a quick tap can be over before the stream
   * arrives. Without this flag that tap starts a recording nobody is holding.
   */
  const held = useRef(false);
  /** Guards every `setState` reachable from an async continuation. */
  const alive = useRef(true);

  const clearTimers = useCallback(() => {
    if (capTimer.current !== null) clearTimeout(capTimer.current);
    if (tick.current !== null) clearInterval(tick.current);
    capTimer.current = null;
    tick.current = null;
  }, []);

  /**
   * Hand the microphone back. Called on every exit path, successful or not —
   * the OS recording indicator staying lit after a press is both alarming and,
   * on some phones, a battery drain that outlives the page.
   */
  const release = useCallback(() => {
    clearTimers();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
  }, [clearTimers]);

  useEffect(
    () => () => {
      alive.current = false;
      held.current = false;
      // A recorder still running at unmount would fire `onstop` into a dead
      // component; `release()` drops the tracks, and `alive` drops the writes.
      const active = recorder.current;
      if (active !== null && active.state !== "inactive") active.stop();
      release();
    },
    [release]
  );

  /* ------------------------------------------------------------------------ */
  /* Hop 2 — the board writer                                                 */
  /* ------------------------------------------------------------------------ */

  const generate = api.board.generate.useMutation();

  const runGenerate = useCallback(
    (prompt: string) => {
      setPhase({ step: "generating" });
      // Per-call callbacks, so this never returns a rejected promise to a void
      // context — `mutate` reports through these and nothing escapes.
      generate.mutate(
        { boardId, prompt, baseRevision },
        {
          onSuccess: (result) => {
            if (!alive.current) return;
            onWritten?.(result.state.revision);
            setPhase({
              step: "done",
              truncated: result.truncated,
              repaired: result.repaired,
            });
            void utils.board.history.invalidate();
          },
          onError: () => {
            if (!alive.current) return;
            setPhase({ step: "error", fault: { kind: "generate" } });
          },
        }
      );
    },
    // `generate.mutate` and `utils` are stable; `baseRevision` is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, baseRevision, onWritten]
  );

  /* ------------------------------------------------------------------------ */
  /* Hop 1 — audio to text                                                    */
  /* ------------------------------------------------------------------------ */

  const runTranscribe = useCallback(
    async (blob: Blob) => {
      setPhase({ step: "transcribing" });

      const query = new URLSearchParams({
        boardId,
        // The phone's UI language as a hint only; the route ignores anything
        // that is not one of the app's locales and Whisper detects otherwise.
        lang: i18n.language,
      });

      // `.then(ok, err)` rather than try/catch: a fetch that rejects (offline,
      // aborted) is a value here, never an unhandled rejection.
      const response = await fetch(`/api/transcribe?${query.toString()}`, {
        method: "POST",
        // Explicit, because a Blob with an empty `type` would otherwise be sent
        // with no content-type and the route's audio check would refuse it.
        headers: { "content-type": blob.type || "audio/webm" },
        body: blob,
      }).then(
        (res) => ({ ok: true as const, res }),
        () => ({ ok: false as const })
      );

      if (!alive.current) return;
      if (!response.ok) {
        setPhase({
          step: "error",
          fault: { kind: "transcribe", reason: null },
        });
        return;
      }

      const body: unknown = await response.res.json().then(
        (value: unknown) => value,
        () => null
      );
      if (!alive.current) return;

      const outcome = readTranscribeOutcome(response.res.status, body);
      if (!outcome.ok) {
        setPhase({
          step: "error",
          fault: { kind: "transcribe", reason: outcome.reason },
        });
        return;
      }

      // Shown *before* the board flips, and left up while it does, so a misheard
      // phrase is obvious at the moment it becomes someone's living-room wall.
      setTranscript(outcome.transcript);
      runGenerate(outcome.transcript);
    },
    [boardId, i18n.language, runGenerate]
  );

  /* ------------------------------------------------------------------------ */
  /* Recording                                                                */
  /* ------------------------------------------------------------------------ */

  const finish = useCallback(() => {
    const heldFor = Date.now() - startedAt.current;
    const type = chunks.current[0]?.type ?? "";
    const blob = new Blob(chunks.current, type === "" ? undefined : { type });
    chunks.current = [];
    release();

    if (!alive.current) return;

    // A tap, not speech. Refused here rather than uploaded: the round trip and
    // the inference call would both be spent to be told the same thing.
    if (heldFor < MIN_RECORDING_MS || blob.size === 0) {
      setPhase({ step: "error", fault: { kind: "tooShort" } });
      return;
    }
    void runTranscribe(blob);
  }, [release, runTranscribe]);

  const stop = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    clearTimers();
    const active = recorder.current;
    // Nothing running yet: the press was over before `getUserMedia` resolved.
    // `held` is already false, so `start`'s continuation will bin the stream.
    if (active === null) return;
    if (active.state !== "inactive") active.stop();
  }, [clearTimers]);

  const start = useCallback(async () => {
    held.current = true;
    setTranscript(null);
    setPhase({ step: "recording" });
    setElapsed(0);

    // Checked before the capability test: an insecure origin hides
    // `mediaDevices` entirely, so without this branch a perfectly capable phone
    // is told its browser cannot record.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      held.current = false;
      setPhase({ step: "error", fault: { kind: "insecure" } });
      return;
    }

    if (
      typeof navigator === "undefined" ||
      navigator.mediaDevices === undefined ||
      typeof MediaRecorder === "undefined"
    ) {
      held.current = false;
      setPhase({ step: "error", fault: { kind: "unsupported" } });
      return;
    }

    const opened = await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(
        (media) => ({ ok: true as const, media }),
        (cause: unknown) => ({ ok: false as const, cause })
      );

    if (!opened.ok) {
      held.current = false;
      if (!alive.current) return;
      // `NotAllowedError` is a refusal (or a policy block); anything else is a
      // device that could not be opened. Different copy, because "allow the
      // microphone" is useless advice to someone whose mic is already in use.
      const name =
        typeof opened.cause === "object" &&
        opened.cause !== null &&
        "name" in opened.cause
          ? String((opened.cause as { name: unknown }).name)
          : "";
      const denied = name === "NotAllowedError" || name === "SecurityError";
      setPhase({
        step: "error",
        fault: { kind: denied ? "denied" : "mic" },
      });
      return;
    }

    // Released (or unmounted) while the OS prompt was up. Give the microphone
    // straight back and stay idle — a tap must not leave a recording running.
    if (!held.current || !alive.current) {
      opened.media.getTracks().forEach((track) => track.stop());
      if (alive.current) setPhase({ step: "idle" });
      return;
    }

    stream.current = opened.media;
    chunks.current = [];
    startedAt.current = Date.now();

    const mimeType = pickRecorderMimeType((type) =>
      MediaRecorder.isTypeSupported(type)
    );
    const active = new MediaRecorder(
      opened.media,
      mimeType === undefined ? undefined : { mimeType }
    );
    recorder.current = active;
    active.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    active.onstop = finish;
    active.onerror = () => {
      held.current = false;
      release();
      if (alive.current) setPhase({ step: "error", fault: { kind: "mic" } });
    };
    active.start();

    // The cap. Independent of every pointer event, so a gesture the platform
    // swallows still cannot hold the microphone open.
    capTimer.current = setTimeout(stop, MAX_RECORDING_MS);
    tick.current = setInterval(() => {
      if (alive.current) setElapsed(Date.now() - startedAt.current);
    }, 100);
  }, [finish, release, stop]);

  /* ------------------------------------------------------------------------ */
  /* Pointer wiring                                                           */
  /* ------------------------------------------------------------------------ */

  const busy = isBusy(phase);
  const disabled = pending || phase.step === "transcribing" || phase.step === "generating";

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled || busy) return;
      // Stops the long-press text-selection / callout gesture on iOS, which
      // otherwise steals the pointer mid-recording.
      event.preventDefault();
      void start();
    },
    [busy, disabled, start]
  );

  const readout = `${formatElapsed(elapsed)} / ${formatElapsed(MAX_RECORDING_MS)}`;
  const recording = phase.step === "recording";

  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <ConsoleLabel>{t("control.voice.title")}</ConsoleLabel>
        {recording && <ConsoleReadout value={readout} />}
      </div>

      <div
        className="flex flex-col gap-2 rounded-none p-2"
        style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
      >
        {/*
          One tall key. No fill of its own — the console's single filled control
          is "Send", and a second one would make the panel argue with itself.
          Recording is signalled with the amber hairline and the amber lamp,
          which is what amber is for here: state, never an action surface.
        */}
        <button
          type="button"
          className={cn(
            "flex h-20 w-full touch-none items-center justify-center gap-3 rounded-none",
            "text-[12px] font-semibold uppercase select-none disabled:opacity-40"
          )}
          style={{
            backgroundColor: CONSOLE.well,
            color: recording ? CONSOLE.amber : CONSOLE.ink,
            letterSpacing: "0.18em",
            boxShadow: recording
              ? `${WELL_LIP}, inset 0 0 0 2px ${CONSOLE.amber}`
              : WELL_LIP,
            touchAction: "none",
          }}
          disabled={disabled}
          aria-pressed={recording}
          onPointerDown={onPointerDown}
          onPointerUp={stop}
          // A finger that slides off the key, a gesture the browser reclaims as
          // a scroll, and a capture lost to the platform: all releases.
          onPointerCancel={stop}
          onPointerLeave={stop}
          onLostPointerCapture={stop}
          onContextMenu={(event) => event.preventDefault()}
          data-testid="control-ptt"
          data-recording={recording}
        >
          {phase.step === "error" &&
          (phase.fault.kind === "denied" ||
            phase.fault.kind === "unsupported" ||
            phase.fault.kind === "insecure") ? (
            <IconMicrophoneOff className="size-6 shrink-0" aria-hidden />
          ) : (
            <IconMicrophone className="size-6 shrink-0" aria-hidden />
          )}
          {recording ? t("control.voice.release") : t("control.voice.hold")}
        </button>

        {/*
          The state line is always rendered, even at idle. A row that appears and
          disappears reflows the panel under a thumb that is mid-press, and the
          idle copy is the instruction anyway.
        */}
        <div
          className="flex items-center gap-2.5 px-1.5 py-1"
          role="status"
          aria-live="polite"
          data-testid="control-ptt-state"
          data-step={phase.step}
          data-fault={phase.step === "error" ? phase.fault.kind : undefined}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0",
              phase.step === "error" && "bg-destructive",
              recording && "animate-pulse"
            )}
            style={
              phase.step === "error"
                ? undefined
                : {
                    backgroundColor:
                      phase.step === "idle" ? CONSOLE.inkMute : CONSOLE.amber,
                  }
            }
          />
          <p
            className={cn(
              "text-[11px] leading-snug font-medium uppercase",
              phase.step === "error" && "text-destructive"
            )}
            style={{
              letterSpacing: "0.14em",
              ...(phase.step === "error" ? {} : { color: CONSOLE.inkDim }),
            }}
            data-testid={phase.step === "error" ? "control-ptt-error" : undefined}
          >
            {stateCopy(phase, t)}
          </p>
        </div>

        {/*
          What we heard. Sentence case and not uppercase — this is the one string
          on the console that came out of the user's own mouth, and reading it
          back in the panel's label register would make a misheard word harder to
          spot, not easier.
        */}
        {transcript !== null && (
          <p
            className="px-1.5 py-1.5 text-[13px] leading-snug"
            style={{
              backgroundColor: CONSOLE.track,
              boxShadow: "inset 0 1px 0 rgba(0,0,0,0.5)",
              color: CONSOLE.ink,
            }}
            data-testid="control-ptt-transcript"
          >
            {`“${transcript}”`}
          </p>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Phase → one line of copy. Exported and pure so the mapping is checkable
 * without a DOM: every branch must resolve to a real `control.voice.*` key, in
 * both locales.
 *
 * `truncated` and `repaired` are **not** errors and are worded so: the board
 * changed either way. `truncated` is the louder of the two because the user lost
 * words they said; `repaired` only means the writer needed a second pass.
 */
export const voiceCopyKey = (phase: VoicePhase): string => {
  switch (phase.step) {
    case "idle":
      return "control.voice.hint";
    case "recording":
      return "control.voice.recording";
    case "transcribing":
      return "control.voice.transcribing";
    case "generating":
      return "control.voice.generating";
    case "done":
      if (phase.truncated) return "control.voice.trimmed";
      return phase.repaired ? "control.voice.repaired" : "control.voice.done";
    case "error":
      switch (phase.fault.kind) {
        case "denied":
          return "control.voice.error.denied";
        case "unsupported":
          return "control.voice.error.unsupported";
        case "insecure":
          return "control.voice.error.insecure";
        case "tooShort":
          return "control.voice.error.too_short";
        case "mic":
          return "control.voice.error.mic";
        case "transcribe":
          return "control.voice.error.transcribe";
        case "generate":
          return "control.voice.error.generate";
      }
  }
};

const stateCopy = (
  phase: VoicePhase,
  t: (key: string) => string
): string => {
  // The server's own user-facing reason wins when it sent one — it is more
  // specific than any string we could pick from here ("the recording was
  // empty" vs "that didn't work").
  if (
    phase.step === "error" &&
    phase.fault.kind === "transcribe" &&
    phase.fault.reason !== null
  ) {
    return phase.fault.reason;
  }
  return t(voiceCopyKey(phase));
};
