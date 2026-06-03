import React, { useEffect, useRef, useState } from "react";
import { Alert, Box, Flex, Link } from "@hubspot/ui-extensions";

// Subscribes to `studio:hsAction` CustomEvents emitted by the renderer's
// SDK action handlers (see renderer/actions.js) and renders them as a
// vertical stack of HubSpot Alerts above the Canvas. Today only `addAlert`
// has a UI representation; other SDK actions (closeOverlay, openIframeModal)
// just no-op in preview, but the listener is centralized here so adding
// affordances for them later is a one-liner.
//
// Each toast auto-dismisses after AUTO_DISMISS_MS unless dismissed manually.
// Stack is capped at MAX_VISIBLE so a misbehaving spec can't drown the UI.

const AUTO_DISMISS_MS = 4000;
const MAX_VISIBLE = 4;

// Maps SDK addAlert `type` strings to HubSpot Alert `variant` strings.
// HubSpot's Alert uses `info | success | warning | error` (no `tip` or
// `danger`), so we adapt: tip → info, danger → error.
const TYPE_TO_VARIANT = {
  info: "info",
  tip: "info",
  success: "success",
  warning: "warning",
  danger: "error",
};

export const PreviewToasts = () => {
  const [toasts, setToasts] = useState([]);
  // Stable ref so cleanup doesn't fight re-renders.
  const idRef = useRef(0);

  useEffect(() => {
    // HubSpot UI extensions run in a sandbox without `window` — bail early
    // instead of crashing at render. Same applies to setTimeout/CustomEvent:
    // they're DOM globals that may not exist in the extension runtime.
    if (
      typeof window === "undefined" ||
      typeof window.addEventListener !== "function"
    ) {
      return undefined;
    }
    const handler = (event) => {
      const detail = event?.detail;
      if (!detail || detail.name !== "addAlert") return;
      const payload = detail.payload || {};
      const id = ++idRef.current;
      const variant = TYPE_TO_VARIANT[payload.type] || "info";
      const toast = {
        id,
        variant,
        title: payload.title || "",
        message: payload.message || "",
      };
      setToasts((prev) => {
        const next = [...prev, toast];
        return next.length > MAX_VISIBLE
          ? next.slice(next.length - MAX_VISIBLE)
          : next;
      });
      if (typeof setTimeout === "function") {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, AUTO_DISMISS_MS);
      }
    };
    window.addEventListener("studio:hsAction", handler);
    return () => window.removeEventListener("studio:hsAction", handler);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <Box>
      <Flex direction="column" gap="xs">
        {toasts.map((t) => (
          <Alert key={t.id} variant={t.variant} title={t.title || undefined}>
            <Flex direction="row" justify="between" align="center" gap="sm">
              <Box>{t.message}</Box>
              <Link
                onClick={() =>
                  setToasts((prev) => prev.filter((x) => x.id !== t.id))
                }
              >
                Dismiss
              </Link>
            </Flex>
          </Alert>
        ))}
      </Flex>
    </Box>
  );
};
