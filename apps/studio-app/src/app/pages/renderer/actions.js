// Action descriptors attached to event-handler props (onClick, onChange, …).
// makeAction returns a function that, when called, dispatches the action
// against the current ctx. Expression fields inside the descriptor are
// resolved at dispatch time so iteration variables still bind correctly.
//
// The SDK actions below mirror the universal HubSpot UI extensions
// `actions` object (addAlert, reloadPage, copyTextToClipboard, closeOverlay,
// openIframeModal, refreshObjectProperties). Studio renders specs in a
// preview environment — not inside a deployed extension — so these handlers
// implement preview-fidelity stand-ins:
//   - direct browser APIs where possible (clipboard, location.reload)
//   - a CustomEvent on window so Studio's outer chrome can hook UX (toasts,
//     overlay management) — listen for `studio:hsAction` if you want to
//     intercept any of them.
//   - console.info no-op + event for SDK actions that genuinely need the
//     host (refreshObjectProperties, closeOverlay) so the spec renders
//     without errors and Studio can display "would have called X" affordances.

import { resolve } from "./resolve.js";

export function makeAction(descriptor, ctx) {
  return (...args) => runAction(descriptor, ctx, args);
}

function runAction(descriptor, ctx, args) {
  const kind = descriptor.$action;
  const handler = HANDLERS[kind];
  if (!handler) {
    console.warn(`[Canvas] Unknown action: ${kind}`);
    return;
  }
  // Bind event-handler args into ctx so descriptor fields can reference
  // them — `"$value"` is the first arg (the convention HubSpot's controlled
  // components follow: onChange(value), onSelectedChange(tabId), etc.) and
  // `"$args"` exposes the full positional list for multi-arg callbacks.
  // Without this, specs like `{ "$action": "setState", "value": "$value" }`
  // silently resolve to undefined and clobber state.
  const callCtx =
    args && args.length > 0
      ? { ...ctx, value: args[0], args }
      : ctx;
  return handler(descriptor, callCtx, args);
}

// Notify any outer Studio chrome that an SDK action fired. Wrapped in a
// try/catch + window guard so the renderer stays SSR-safe.
function emitHsAction(name, payload) {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("studio:hsAction", { detail: { name, payload } }),
    );
  } catch (err) {
    console.warn("[Canvas] failed to dispatch studio:hsAction", err);
  }
}

const HANDLERS = {
  // Renderer-native — fire multiple actions in sequence from one click.
  // Used when a single user gesture should both perform a side effect AND
  // surface feedback (e.g. copy email + addAlert success toast).
  // Shape: { $action: "batch", actions: [ {$action:...}, {$action:...} ] }
  batch: (d, ctx, args) => {
    const list = Array.isArray(d.actions) ? d.actions : [];
    for (const inner of list) {
      if (inner && typeof inner === "object" && "$action" in inner) {
        runAction(inner, ctx, args);
      }
    }
  },

  // Renderer-native — sets a key on the controlled state object that
  // Canvas threads through ctx.setState.
  setState: (d, ctx) => {
    const key = d.key;
    const value = resolve(d.value, ctx);
    ctx.setState(key, value);
  },

  // SDK: actions.addAlert({ title, message, type }). type is one of
  // info | tip | success | warning | danger (defaults to info).
  addAlert: (d, ctx) => {
    const payload = {
      title: resolve(d.title, ctx),
      message: resolve(d.message, ctx),
      type: resolve(d.type, ctx) || "info",
    };
    emitHsAction("addAlert", payload);
    if (ctx.hostActions?.addAlert) {
      try {
        ctx.hostActions.addAlert(payload);
        return;
      } catch (err) {
        console.warn("[hs-action] addAlert failed, falling through:", err);
      }
    }
    // Console fallback so a missing chrome listener still surfaces the alert
    // during local prototyping.
    console.info("[hs-action] addAlert:", payload);
  },

  // SDK: actions.reloadPage(). In preview this reloads the Studio app
  // page itself — almost never what you want during prototyping. We
  // emit + log instead, and only reload if the chrome explicitly opts in
  // by setting `confirmReload: true` on the descriptor.
  reloadPage: (d, ctx) => {
    emitHsAction("reloadPage", {});
    if (d.confirmReload === true && ctx.hostActions?.reloadPage) {
      // Only reload when the spec opts in — reloading the Studio host
      // page itself is almost never what authors want during prototyping.
      ctx.hostActions.reloadPage();
      return;
    }
    console.info("[hs-action] reloadPage (no-op in preview)");
    if (d.confirmReload === true && typeof window !== "undefined") {
      window.location.reload();
    }
  },

  // SDK: actions.copyTextToClipboard(text). Promise-returning in the SDK;
  // we mirror that with navigator.clipboard.writeText.
  copyTextToClipboard: (d, ctx) => {
    const value = resolve(d.value, ctx);
    emitHsAction("copyTextToClipboard", { value });
    if (value === undefined || value === null) return;
    const text = String(value);
    // Prefer the host SDK action — navigator.clipboard is blocked in
    // HubSpot's cross-origin extension iframe (no clipboard-write permission).
    if (ctx.hostActions?.copyTextToClipboard) {
      try {
        return ctx.hostActions.copyTextToClipboard(text);
      } catch (err) {
        console.warn(
          "[hs-action] hostActions.copyTextToClipboard failed, falling back:",
          err,
        );
      }
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      return navigator.clipboard.writeText(text);
    }
  },

  // Back-compat alias — earlier specs were emitted with `copyToClipboard`
  // before we knew the canonical SDK name.
  copyToClipboard: (d, ctx) => HANDLERS.copyTextToClipboard(d, ctx),

  // SDK: actions.closeOverlay(id). hs-uix Modal/Panel manage their own
  // open/close in production via the host overlay registry. In Studio's
  // preview these primitives don't have a working close hook, so we just
  // emit so any chrome listener can simulate it.
  closeOverlay: (d, ctx) => {
    const id = resolve(d.id, ctx);
    emitHsAction("closeOverlay", { id });
    if (ctx.hostActions?.closeOverlay) {
      try {
        ctx.hostActions.closeOverlay(id);
        return;
      } catch (err) {
        console.warn("[hs-action] closeOverlay failed:", err);
      }
    }
    console.info("[hs-action] closeOverlay (preview no-op):", id);
  },

  // SDK: actions.openIframeModal({uri, height, width, title?, flush?}, cb?).
  // Preview can't render the host's modal chrome, so we emit + log.
  openIframeModal: (d, ctx) => {
    const payload = {
      uri: resolve(d.uri, ctx),
      height: resolve(d.height, ctx),
      width: resolve(d.width, ctx),
      title: resolve(d.title, ctx),
      flush: resolve(d.flush, ctx),
    };
    emitHsAction("openIframeModal", payload);
    if (ctx.hostActions?.openIframeModal) {
      try {
        ctx.hostActions.openIframeModal(payload);
        return;
      } catch (err) {
        console.warn("[hs-action] openIframeModal failed:", err);
      }
    }
    console.info("[hs-action] openIframeModal (preview no-op):", payload);
  },

  // SDK (CRM-only): actions.refreshObjectProperties(). No CRM record in
  // preview, so this is purely emit + log.
  refreshObjectProperties: (_d, ctx) => {
    emitHsAction("refreshObjectProperties", {});
    if (ctx.hostActions?.refreshObjectProperties) {
      try {
        ctx.hostActions.refreshObjectProperties();
        return;
      } catch (err) {
        console.warn("[hs-action] refreshObjectProperties failed:", err);
      }
    }
    console.info("[hs-action] refreshObjectProperties (preview no-op)");
  },
};
