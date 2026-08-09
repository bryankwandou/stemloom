"use client";

/**
 * Registers the service worker and reports offline readiness.
 *
 * Registration is deferred until after load so it never competes with the
 * first paint or the audio context for main-thread time.
 */

import { useEffect, useState } from "react";

export function OfflineReady() {
  const [state, setState] = useState<"idle" | "ready" | "offline">("idle");

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then(() => setState("ready"))
        .catch(() => {
          // A failed registration is not fatal; the app still works, it
          // just will not survive going offline.
        });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    const goOffline = () => setState("offline");
    const goOnline = () => setState("ready");
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  if (state !== "offline") return null;

  return (
    <div className="fixed bottom-4 left-4 z-[60] flex items-center gap-2 rounded-full border border-line bg-panel px-3.5 py-1.5 text-[12px] text-ink-dim shadow-lg">
      <span className="size-1.5 rounded-full bg-live" />
      Offline. Everything still works.
    </div>
  );
}
