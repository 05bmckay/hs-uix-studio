import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Alert, Text } from "@hubspot/ui-extensions";
import { renderNode } from "./renderNode.jsx";
import { makeAction } from "./actions.js";

class CanvasErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("[Canvas] descendant render failed:", error);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <Alert variant="error" title="Preview failed to render">
          {String(this.state.error?.message || this.state.error)}
        </Alert>
      );
    }
    return this.props.children;
  }
}

// Canvas takes a spec and renders the component tree. When commentMode is
// on, commentable nodes (per commentable.js) are wrapped inline with a
// CommentTarget. The wrapper only applies inside column-oriented parents,
// so headers, action rows, and inline tags don't get squeezed.
export const Canvas = ({
  spec,
  state,
  onStateChange,
  commentMode = false,
  comments = [],
  onAddComment,
  actions: hostActions,
}) => {
  const setState = useCallback(
    (key, value) => {
      onStateChange?.(key, value);
    },
    [onStateChange],
  );

  const commentedNodeIds = useMemo(
    () => new Set(comments.map((c) => c.nodeId)),
    [comments],
  );

  // `spec.watch` is a map of state-key → action (or array of actions). When
  // the watched key's value changes (reference inequality), fire each action.
  // Skip the initial mount — watchers react to changes, not to "this is the
  // starting value." Author-beware: a watcher that writes the same key it
  // watches will loop forever.
  const prevStateRef = useRef(null);
  useEffect(() => {
    const watch = spec?.watch;
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (!watch || typeof watch !== "object") return;
    if (prev == null) return; // initial render — snapshot only
    const current = state || {};
    const dispatchCtx = {
      state: current,
      data: spec.data || {},
      elements: spec.elements ?? null,
      setState,
      hostActions,
    };
    for (const [key, spec_] of Object.entries(watch)) {
      if (prev[key] === current[key]) continue;
      const actions = Array.isArray(spec_) ? spec_ : [spec_];
      for (const action of actions) {
        if (!action || typeof action !== "object" || !("$action" in action)) continue;
        try {
          makeAction(action, dispatchCtx)();
        } catch (err) {
          console.warn(`[Canvas] watcher "${key}" failed:`, err);
        }
      }
    }
  }, [state, spec?.watch, spec?.data, spec?.elements, setState]);

  if (!spec || !spec.root) {
    return <Text variant="microcopy">No spec provided.</Text>;
  }

  // v1 shape: `root` is a string ID, `elements` is the adjacency-list map.
  // Back-compat: v0 specs had `root` as an inline node — render directly.
  const isV1 = typeof spec.root === "string" && spec.elements;
  const rootNode = isV1 ? spec.elements[spec.root] : spec.root;
  if (!rootNode) {
    // During Phase-2 patch streaming, the root ID arrives before its element
    // does — render nothing quietly rather than flashing an error Alert. If
    // the spec is genuinely broken (e.g. model emitted a root ID with no
    // matching element entry) it'll show up in logs.
    if (isV1) {
      console.warn(`[Canvas] spec.root "${spec.root}" not yet in elements`);
      return null;
    }
    return (
      <Alert variant="error" title="Preview failed to render">
        spec has no root node
      </Alert>
    );
  }

  const ctx = {
    state: state || {},
    data: spec.data || {},
    elements: isV1 ? spec.elements : null,
    setState,
    commentMode,
    commentedNodeIds,
    onAddComment,
    hostActions,
  };

  try {
    const preview = renderNode(rootNode, ctx, {
      path: isV1 ? `elements.${spec.root}` : "root",
      parentType: null,
      parentDirection: null,
    });
    return (
      <CanvasErrorBoundary resetKey={spec}>
        {preview}
      </CanvasErrorBoundary>
    );
  } catch (err) {
    console.error("[Canvas] render failed:", err);
    return (
      <Alert variant="error" title="Preview failed to render">
        {String(err?.message || err)}
      </Alert>
    );
  }
};
