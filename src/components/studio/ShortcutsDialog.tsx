"use client";

/**
 * Keyboard reference.
 *
 * Anyone editing audio seriously stops touching the toolbar within a day,
 * so the shortcuts need to be discoverable without hunting through a
 * manual that does not exist.
 */

import { useEffect } from "react";

const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Transport",
    keys: [
      ["Space", "Play or pause"],
      ["Home", "Return the playhead to the start"],
      ["Click on a lane", "Move the playhead there"],
      ["Drag across a lane", "Select a range"],
    ],
  },
  {
    title: "Editing",
    keys: [
      [`${MOD} C`, "Copy the selection"],
      [`${MOD} X`, "Cut the selection"],
      [`${MOD} V`, "Paste at the playhead"],
      ["Delete", "Remove the selection and close the gap"],
      [`${MOD} Z`, "Undo"],
      [`${MOD} Shift Z`, "Redo"],
    ],
  },
  {
    title: "View",
    keys: [
      ["+", "Zoom in"],
      ["−", "Zoom out"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  // Escape should close this without the user reaching for the mouse,
  // which would rather defeat the point of a shortcuts panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[12px] border border-line bg-panel p-5 anim-weave"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold">Keyboard</h2>

        <div className="mt-4 space-y-5">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h3 className="mb-2 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                {g.title}
              </h3>
              <div className="space-y-1.5">
                {g.keys.map(([combo, what]) => (
                  <div
                    key={combo}
                    className="flex items-baseline justify-between gap-4"
                  >
                    <span className="text-[12.5px] text-ink-dim">{what}</span>
                    <kbd className="tnum shrink-0 rounded-[4px] border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-ink">
                      {combo}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onClose}
          className="mt-5 w-full rounded-[6px] border border-line py-2 text-[12.5px] text-ink-dim transition-colors hover:text-ink"
        >
          Close
        </button>
      </div>
    </div>
  );
}
