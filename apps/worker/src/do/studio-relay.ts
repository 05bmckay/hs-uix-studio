import { getAgentByName } from "agents";
import { RelayBuffer, withDurableStorage } from "@hs-uix/stream-relay/worker";
import type { Env } from "../index";
import type { LegacyChatStartRequest, StudioProjectAgent } from "../agents/studio-project-agent";

interface ChatRelayPayload {
  kind: "chat";
  legacy: LegacyChatStartRequest;
}

type StudioRelayPayload = ChatRelayPayload;

interface ChatRelayMeta {
  kind: "chat";
  usage?: unknown;
  spec?: unknown;
  specVersion?: number;
  specNote?: string | null;
  questions?: unknown;
}

type LegacyPollResponse = {
  status: "streaming" | "done" | "error";
  append?: string;
  nextOffset?: number;
  error?: string;
  usage?: unknown;
  spec?: unknown;
  specVersion?: number;
  specNote?: string | null;
  questions?: unknown;
  phase?: string;
  phaseHistory?: string[];
  patches?: { log?: unknown[]; nextCursor?: number };
};

const DEFAULT_POLL_MS = 400;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function projectAgentName(projectId: string, messageId: string): string {
  // One Agent instance per chat turn keeps in-memory stream buffers isolated
  // even if a user starts multiple generations in the same project.
  return `project:${projectId}:message:${messageId}`;
}

/**
 * Stream Relay DO used for HubSpot-safe short-poll streaming.
 *
 * The relay owns the public /streams protocol. Its upstream starts the
 * project-scoped Cloudflare Agent, then mirrors the Agent's text/progress/spec
 * patches into Stream Relay's text/event/progress channels.
 */
export class StudioRelay extends RelayBuffer<StudioRelayPayload, ChatRelayMeta> {
  constructor(state: DurableObjectState, env: Env) {
    super(
      state,
      env,
      withDurableStorage<StudioRelayPayload, ChatRelayMeta>(state, {
        upstream: async ({ payload, write, emit, progress, heartbeat, signal }) => {
          if (!payload || payload.kind !== "chat") {
            throw new Error("unsupported relay payload");
          }

          const legacy = payload.legacy;
          const agent = await getAgentByName<Env, StudioProjectAgent>(
            env.STUDIO_PROJECT_AGENT,
            projectAgentName(legacy.projectId, legacy.messageId),
            { props: { projectId: legacy.projectId, hubId: String(legacy.hubId) } },
          );

          const startResponse = await agent.fetch("https://agent/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(legacy),
          });
          if (!startResponse.ok) {
            throw new Error(`agent chat stream start failed: ${startResponse.status}`);
          }

          let offset = 0;
          let patchesCursor = 0;
          let lastSpecVersion = 0;
          let finalMeta: ChatRelayMeta = { kind: "chat" };
          const pollMs = Number(env.STREAM_POLL_INTERVAL_MS || DEFAULT_POLL_MS) || DEFAULT_POLL_MS;

          while (!signal.aborted) {
            heartbeat();

            const url = new URL("https://agent/poll");
            url.searchParams.set("since", String(offset));
            url.searchParams.set("patchesSince", String(patchesCursor));

            const response = await agent.fetch(url.toString());
            if (!response.ok) {
              throw new Error(`agent chat stream poll failed: ${response.status}`);
            }

            const data = (await response.json()) as LegacyPollResponse;

            if (typeof data.phase === "string") {
              progress({
                phase: "chat",
                message: data.phase,
                data: { phaseHistory: data.phaseHistory ?? [] },
              });
            }

            if (data.append && data.append.length > 0) {
              write(data.append);
              offset = typeof data.nextOffset === "number" ? data.nextOffset : offset + data.append.length;
            } else if (typeof data.nextOffset === "number") {
              offset = data.nextOffset;
            }

            if (typeof data.specVersion === "number" && data.specVersion > lastSpecVersion && data.spec) {
              lastSpecVersion = data.specVersion;
              finalMeta = {
                ...finalMeta,
                spec: data.spec,
                specVersion: data.specVersion,
                specNote: data.specNote ?? null,
              };
              emit({
                type: "spec.snapshot",
                spec: data.spec,
                specVersion: data.specVersion,
                note: data.specNote ?? null,
              });
            }

            if (data.patches?.log && data.patches.log.length > 0) {
              emit({ type: "spec.patches", patches: data.patches.log });
            }
            if (typeof data.patches?.nextCursor === "number") {
              patchesCursor = data.patches.nextCursor;
            }

            if (data.status === "done") {
              finalMeta = {
                ...finalMeta,
                usage: data.usage,
                ...(data.questions ? { questions: data.questions } : {}),
              };
              return finalMeta;
            }

            if (data.status === "error") {
              throw new Error(data.error || "agent chat stream error");
            }

            await sleep(pollMs, signal);
          }

          throw new Error("stream inactive");
        },
      }),
    );
  }
}
