import { useState, useEffect, useRef } from "react";
import classNames from "clsx";

import { RecordType } from "../core/types";
import { MeeperRecorder, MeeperState, recordMeeper } from "../core/meeper";

import RecordHeader from "./RecordHeader";
import FatalError from "./FatalError";
import { useNoApiKeyToast } from "./ApiKeyDialog";

export default function RecordPage({
  tabId,
  initialRecordType,
}: {
  tabId: number;
  initialRecordType: RecordType;
}) {
  const noApiKeyToast = useNoApiKeyToast();

  const meeperRef = useRef<MeeperRecorder>();
  const [meeperState, setMeeperState] = useState<MeeperState>();
  const [fatalError, setFatalError] = useState<Error | string | null>(null);
  const [closing, setClosing] = useState(false);

  const meeper = meeperRef.current;
  const isActive = meeper?.stream.active;
  const {
    recording = false,
    content = [],
    recordType = initialRecordType,
    pendingTranscriptions = 0,
    lastError = null,
  } = meeperState ?? {};

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 👇️ scroll to bottom every time content change
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [content.length]);

  useEffect(() => {
    const getE2EHooks = () => (globalThis as any).__MEEPER_E2E__;

    if (
      !tabId ||
      !initialRecordType ||
      !Object.values(RecordType).includes(initialRecordType)
    ) {
      window.close();
      return;
    }

    const onError = (err: any) => {
      noApiKeyToast(err);
    };

    const setupAndStart = async () => {
      const e2eBeforeStartHooks = getE2EHooks();
      if (typeof e2eBeforeStartHooks?.beforeStart === "function") {
        await e2eBeforeStartHooks.beforeStart();
      }

      const meeper = await recordMeeper(
        tabId,
        initialRecordType,
        setMeeperState,
        onError,
      );

      meeperRef.current = meeper;

      const e2eReadyHooks = getE2EHooks();
      if (e2eReadyHooks) {
        e2eReadyHooks.ready = true;
        e2eReadyHooks.stop = () => {
          meeper.stop();
        };
      }
    };

    setupAndStart()
      .catch((err) => {
        console.error(err);
        setFatalError(err);
      });
  }, [
    tabId,
    initialRecordType,
    setMeeperState,
    setFatalError,
    noApiKeyToast,
  ]);

  useEffect(() => {
    if ((globalThis as any).__MEEPER_E2E__) {
      (globalThis as any).__MEEPER_E2E__.state = {
        recording,
        content,
        pendingTranscriptions,
        lastError,
        isActive,
      };
    }
  }, [recording, content, pendingTranscriptions, lastError, isActive]);

  useEffect(() => {
    const keepOpenForE2E = Boolean((globalThis as any).__MEEPER_E2E__?.keepOpen);

    // Handle stop
    if (meeper && !isActive && pendingTranscriptions === 0 && !keepOpenForE2E) {
      setClosing(true);
      setTimeout(() => window.close(), 1_500);
    }
  }, [meeper, isActive, pendingTranscriptions]);

  useEffect(() => meeperRef.current?.stop, []);

  useEffect(() => {
    if (!isActive) return;

    try {
      window.onbeforeunload = () =>
        "You have attempted to leave this page. Are you sure?\nThe recording will be stopped and saved!";

      return () => {
        window.onbeforeunload = null;
      };
    } catch {
      return;
    }
  }, [isActive]);

  if (fatalError) {
    return <FatalError error={fatalError} />;
  }

  if (!meeper) return null;

  return (
    <div
      className={classNames(
        "min-h-screen flex flex-col",
        closing && "opacity-75 cursor-wait"
      )}
    >
      <RecordHeader
        meeper={meeper}
        recordType={recordType}
        recording={recording}
        pendingTranscriptions={pendingTranscriptions}
        lastError={lastError}
      />

      <main
        className={classNames(
          "flex-1",
          "container mx-auto max-w-3xl",
          "px-4 py-8 grow bg-white"
        )}
      >
        <article className="relative mx-auto prose prose-slate">
          {content.length > 0
            ? content.map((item, i) => <p key={i}>{item}</p>)
            : "Waiting for audio..."}

          {isActive && (
            <div
              className={classNames(
                "absolute -left-[7rem] top-[calc(100%-2.35rem)]",
                "h-12 w-12",
                "bg-no-repeat",
                "animate-bounce-horizontal"
              )}
              style={{
                backgroundImage: "url(/misc/meeper_horizontal_2.png)",
                backgroundSize: "100% auto",
              }}
            />
          )}
        </article>
      </main>

      <div ref={bottomRef} />
    </div>
  );
}
