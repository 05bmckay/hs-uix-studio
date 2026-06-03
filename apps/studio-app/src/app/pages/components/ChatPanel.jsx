import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Flex,
  Link,
  LoadingSpinner,
  Text,
  Tile,
} from "@hubspot/ui-extensions";

// Lightweight message list. Supports **bold**, *italic*, `code`-as-italic
// inline. Paragraphs split on blank lines.
//
// Windowing: HubSpot card surfaces don't have vertical scroll — long chats
// push the whole page down. We render a character-budgeted window anchored
// to the latest message by default. Users page back with "Show older" at
// the top and return with "Back to latest" at the bottom. A new message or
// incoming stream chunk snaps the window back to the latest turn.
//
// MIN_MESSAGES is a floor — if a single verbose message blows CHAR_BUDGET,
// we still ensure the user sees at least this many turns for continuity.
// Without it, clicking "Show older" against a 400-char reply would reveal
// exactly one new message, which felt stingy in practice.
const CHAR_BUDGET = 500;
const MIN_MESSAGES = 3;
const COLLAPSE_MESSAGE_CHARS = 360;
// Number of paragraphs to show when a long message is collapsed. Tuned to
// match the previous ExpandableText height (~440px) without measuring.
const COLLAPSE_MESSAGE_PARAGRAPHS = 2;
// Nudge the user to start a fresh chat once a thread gets long enough that
// context window pressure starts to matter. Either threshold trips the hint
// — turn count catches chatty back-and-forths, char total catches a few
// very long replies. Tuned conservatively so it doesn't fire on normal use.
const LONG_CHAT_MESSAGE_COUNT = 24;
const LONG_CHAT_CHAR_TOTAL = 24000;

export const ChatPanel = ({
  messages = [],
  hasMore,
  onLoadMore,
  isLoadingMore,
  historyOpen,
  history = [],
  onSelectHistory,
  onNewChat,
  activeChatId,
  // Streaming indicator plumbing — parent tells us which message id is
  // actively streaming and the current phase label from the worker DO.
  streamingMessageId,
  streamPhase,
  // True when the worker's 90s server-stall guard fired. The DO is dead;
  // resume polling won't recover. We surface a Reload affordance so the user
  // can reattach against a clean slate.
  streamStalled = false,
  usageExhausted = false,
  onReload,
  onOpenSettings,
}) => {
  // windowEnd is the exclusive upper bound of the visible slice — when
  // equal to messages.length we're "at latest" and a new message keeps us
  // pinned there. User actions mutate this: "Show older" shifts it left,
  // "Back to latest" resets it. If the user has scrolled back, streaming
  // growth won't yank them forward.
  const [windowEnd, setWindowEnd] = useState(messages.length);

  useEffect(() => {
    // Snap to latest whenever a new message is appended.
    setWindowEnd(messages.length);
  }, [messages.length]);
  if (historyOpen) {
    return (
      <HistoryList
        history={history}
        activeChatId={activeChatId}
        onSelect={onSelectHistory}
        onNewChat={onNewChat}
      />
    );
  }

  if (messages.length === 0) {
    // Empty state lives outside the tab body in ProjectPage so its centering
    // isn't squeezed by the tab content layout.
    return null;
  }

  // Build the visible window by walking backward from windowEnd accumulating
  // message-content characters until CHAR_BUDGET is exceeded — but always
  // include at least MIN_MESSAGES turns before stopping, so a single verbose
  // reply doesn't starve the window.
  const effectiveEnd = Math.min(Math.max(windowEnd, 1), messages.length);
  let total = 0;
  let start = effectiveEnd;
  for (let i = effectiveEnd - 1; i >= 0; i--) {
    const len = (messages[i]?.content || "").length;
    const included = effectiveEnd - start;
    if (total + len > CHAR_BUDGET && included >= MIN_MESSAGES) break;
    total += len;
    start = i;
  }
  const visible = messages.slice(start, effectiveEnd);
  const hasLocalOlder = start > 0;
  const hasServerOlder = Boolean(hasMore);
  const hasOlder = hasLocalOlder || hasServerOlder;
  const isAtLatest = effectiveEnd >= messages.length;

  const showOlder = () => {
    // Prefer shifting the local window back; only fall through to the
    // server fetch when we've already exposed every local message.
    if (hasLocalOlder) {
      setWindowEnd(Math.max(start, 1));
      return;
    }
    if (hasServerOlder && onLoadMore) onLoadMore();
  };
  const goLatest = () => setWindowEnd(messages.length);

  const olderLabel = hasLocalOlder
    ? "Show older messages"
    : isLoadingMore
      ? "Loading..."
      : "Show earlier messages";

  return (
    <Flex direction="column" gap="sm">
      {streamStalled && (
        <Alert title="Generation stalled" variant="warning">
          <Flex direction="column" gap="xs">
            <Text>
              The model stopped responding. Reload to reattach — your chat
              history is saved.
            </Text>
            {onReload && (
              <Flex direction="row" justify="start">
                <Button size="xs" variant="primary" onClick={onReload}>
                  Reload
                </Button>
              </Flex>
            )}
          </Flex>
        </Alert>
      )}
      {usageExhausted && (
        <Flex direction="row" justify="center">
          <Text variant="microcopy" format={{ italic: true }}>
            You're out of Studio usage.{" "}
            {onOpenSettings ? (
              <Link inline={true} onClick={onOpenSettings}>
                Go to settings
              </Link>
            ) : (
              "Go to settings"
            )}{" "}
            to buy more before starting another chat.
          </Text>
        </Flex>
      )}
      {hasOlder && (
        <Flex direction="row" justify="center">
          <Link onClick={showOlder}>{olderLabel}</Link>
        </Flex>
      )}
      {visible.map((m) => (
        <Message
          key={m.id}
          message={m}
          streamPhase={
            streamingMessageId && m.id === streamingMessageId ? streamPhase : null
          }
        />
      ))}
      {!isAtLatest && (
        <Flex direction="row" justify="center">
          <Link onClick={goLatest}>Back to latest</Link>
        </Flex>
      )}
      {isAtLatest && isLongChat(messages) && (
        <Flex direction="row" justify="center">
          <Text variant="microcopy" format={{ italic: true }}>
            This chat is getting long.{" "}
            {onNewChat ? (
              <Link inline={true} onClick={onNewChat}>
                Start a new chat
              </Link>
            ) : (
              "Consider starting a new chat"
            )}{" "}
            to keep responses fast and focused.
          </Text>
        </Flex>
      )}
    </Flex>
  );
};

function isLongChat(messages) {
  if (!Array.isArray(messages)) return false;
  if (messages.length >= LONG_CHAT_MESSAGE_COUNT) return true;
  let total = 0;
  for (const m of messages) {
    total += (m?.content || "").length;
    if (total >= LONG_CHAT_CHAR_TOTAL) return true;
  }
  return false;
}

const HistoryList = ({ history, activeChatId, onSelect, onNewChat }) => {
  const hasEntries = Array.isArray(history) && history.length > 0;
  return (
    <Flex direction="column" gap="xs">
      {onNewChat && (
        <Flex direction="row" justify="end">
          <Link onClick={onNewChat}>+ New chat</Link>
        </Flex>
      )}
      {!hasEntries && (
        <Text variant="microcopy">No previous chats on this project yet.</Text>
      )}
      {hasEntries &&
        history.map((entry) => (
          <Tile key={entry.id} compact={true}>
            <Flex direction="column" gap="flush">
              <Text format={{ fontWeight: "demibold" }}>
                <Link onClick={() => onSelect?.(entry.id)}>
                  {entry.title}
                  {entry.id === activeChatId ? " · current" : ""}
                </Link>
              </Text>
              <Text variant="microcopy">
                {formatRelative(entry.updatedAt)}
              </Text>
            </Flex>
          </Tile>
        ))}
    </Flex>
  );
};

function formatRelative(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const Message = ({ message, streamPhase }) => {
  if (message.role === "system") {
    return (
      <Flex direction="row" justify="center">
        <Text variant="microcopy" format={{ italic: true }}>
          {stripTags(message.content)}
        </Text>
      </Flex>
    );
  }

  const paragraphs = splitParagraphs(message.content);
  const roleLabel = message.role === "user" ? "You" : "Studio";
  const showPhase =
    message.role === "assistant" &&
    typeof streamPhase === "string" &&
    streamPhase.length > 0 &&
    streamPhase !== "Done";
  const shouldCollapse =
    !showPhase && (message.content || "").length > COLLAPSE_MESSAGE_CHARS;

  return (
    <Flex direction="column" gap="xs">
      <Text variant="microcopy" format={{ fontWeight: "demibold" }}>
        {roleLabel}
      </Text>
      {shouldCollapse ? (
        <CollapsibleParagraphs paragraphs={paragraphs} />
      ) : (
        paragraphs.map((para, i) => (
          <Text key={i}>{renderInline(para)}</Text>
        ))
      )}
      {showPhase && (
        <Flex direction="row" align="center" gap="xs">
          <LoadingSpinner size="xs" />
          <Text variant="microcopy" format={{ italic: true }}>
            {streamPhase}…
          </Text>
        </Flex>
      )}
    </Flex>
  );
};

// Local collapse for long assistant messages. We can't use
// ExpandableText (from @hubspot/ui-extensions/experimental) because it
// only accepts plain string children — feeding it our paragraph array
// stripped the **bold**/`code` formatting that renderInline produces.
// This keeps rich text working in both collapsed and expanded states.
function CollapsibleParagraphs({ paragraphs }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded
    ? paragraphs
    : paragraphs.slice(0, COLLAPSE_MESSAGE_PARAGRAPHS);
  const hasMore = paragraphs.length > COLLAPSE_MESSAGE_PARAGRAPHS;
  return (
    <Flex direction="column" gap="xs">
      {visible.map((para, i) => (
        <Text key={i}>{renderInline(para)}</Text>
      ))}
      {hasMore && (
        <Link onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show full message"}
        </Link>
      )}
    </Flex>
  );
}

function splitParagraphs(content) {
  if (!content) return [];
  return content
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);
}

// Tokenize a line into bold/italic/plain spans. Not a full parser — nested
// styles aren't supported, and unmatched markers fall through as literal text.
// Backticks render as italic since Studio uses them for emphasis on technical
// terms and HubSpot's Text doesn't give us a clean monospace treatment here.
function renderInline(text) {
  const parts = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2] != null) {
      parts.push(
        <Text key={key++} inline={true} format={{ fontWeight: "demibold" }}>
          {match[2]}
        </Text>,
      );
    } else if (match[3] != null) {
      parts.push(
        <Text key={key++} inline={true} format={{ italic: true }}>
          {match[3]}
        </Text>,
      );
    } else if (match[4] != null) {
      parts.push(
        <Text key={key++} inline={true} format={{ italic: true }}>
          {match[4]}
        </Text>,
      );
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function stripTags(s) {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, "").trim();
}
