// Small spec that exercises the core renderer features: bindings, template
// strings, visibility gates, expression props. State control (viewMode)
// lives in the TweaksPanel — specs don't need to embed self-testing
// toggle bars anymore. Friendly kebab-case `name` fields give the
// structural outline (comment mode) readable group labels.
export const demoSpec = {
  meta: {
    name: "Renderer smoke test",
    description: "Minimal spec exercising the spec → component pipeline.",
  },
  state: { viewMode: "loaded" },
  data: {
    viewModes: [
      { value: "loaded", label: "Loaded" },
      { value: "loading", label: "Loading" },
      { value: "error", label: "Error" },
    ],
    greeting: "Renderer v0",
    subtitle: "Prompt → spec → HubSpot components, live in the sandbox.",
    metricLabel: "Active prototypes",
    metricValue: "3",
  },
  root: "card-root",
  elements: {
    "card-root": {
      type: "Flex",
      name: "card-root",
      direction: "column",
      gap: "sm",
      children: ["loaded-content", "loading-state", "error-alert"],
    },
    "loaded-content": {
      type: "Flex",
      name: "loaded-content",
      visible: { $eq: ["$state.viewMode", "loaded"] },
      direction: "column",
      gap: "sm",
      children: ["heading", "subtitle", "stats", "working-alert"],
    },
    heading: { type: "Heading", children: "$data.greeting" },
    subtitle: { type: "Text", variant: "microcopy", children: "$data.subtitle" },
    stats: {
      type: "Statistics",
      children: ["stat-item"],
    },
    "stat-item": {
      type: "StatisticsItem",
      label: "$data.metricLabel",
      number: "$data.metricValue",
    },
    "working-alert": {
      type: "Alert",
      variant: "success",
      title: "Renderer working",
      children: "Current viewMode: {{state.viewMode}}",
    },
    "loading-state": {
      type: "Flex",
      name: "loading-state",
      visible: { $eq: ["$state.viewMode", "loading"] },
      align: "center",
      justify: "center",
      children: ["loading-spinner"],
    },
    "loading-spinner": {
      type: "LoadingSpinner",
      size: "sm",
      label: "Loading...",
      showLabel: true,
      layout: "centered",
    },
    "error-alert": {
      type: "Alert",
      visible: { $eq: ["$state.viewMode", "error"] },
      variant: "error",
      title: "Simulated error",
      children: "This is what the error state looks like.",
    },
  },
};
