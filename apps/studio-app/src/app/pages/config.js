// Runtime config. HubSpot UI Extensions don't have build-time env, so values
// here are just constants. Flip WORKER_URL to the deployed worker origin when
// you're ready for real AI round-trips; leave it empty to stay in mock mode
// (the app seeds fake clarifying questions instead of calling Anthropic).
//
// Local dev against `wrangler dev`: use "http://localhost:8787".
// Prod: the workers.dev URL you set as WORKER_PUBLIC_URL on the worker.

export const WORKER_URL = "https://hs-uix-studio-worker.05bmckay.workers.dev";

// Toggled on once the worker + OAuth install are wired end-to-end. While
// false, handleChatSend falls back to mocked questions / no backend call.
export const BACKEND_ENABLED = Boolean(WORKER_URL);
