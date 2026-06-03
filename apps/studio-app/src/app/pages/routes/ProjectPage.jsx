import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AutoGrid,
  Box,
  Button,
  Divider,
  EmptyState,
  Flex,
  Heading,
  Icon,
  Inline,
  Input,
  Link,
  LoadingSpinner,
  Modal,
  ModalBody,
  ModalFooter,
  Tab,
  Tabs,
  Text,
  Tile,
  useExtensionApi,
} from "@hubspot/ui-extensions";
import {
  PageBreadcrumbs,
  usePageRoute,
} from "@hubspot/ui-extensions/pages";

import { Canvas } from "../renderer/Canvas.jsx";
import { applyPatches } from "../renderer/apply-patch.js";
import { PreviewToasts } from "../components/PreviewToasts.jsx";
import { demoSpec } from "../renderer/demoSpec.js";
import { ChatPanel } from "../components/ChatPanel.jsx";
import { CommentsPanel } from "../components/CommentsPanel.jsx";
import { Composer } from "../components/Composer.jsx";
import {
  QuestionsPanel,
  formatAnswersAsMessage,
} from "../components/QuestionsPanel.jsx";
import { TweaksPanel } from "../components/TweaksPanel.jsx";
import { ExportPanel } from "../components/ExportPanel.jsx";
import { BACKEND_ENABLED, WORKER_URL } from "../config.js";
// WORKER_URL is still imported (used by useStream below).
import { useEffectRunner } from "../hooks/useEffectRunner.js";
import { useStream } from "../hooks/useStream.js";
import {
  createProjectPageChatService,
  createProjectPageCommentService,
  createProjectPageModalService,
  createProjectPageQuestionService,
} from "../lib/projectPageServices.js";
import { useProjects } from "../state/projects.jsx";
import { StyledText } from "hs-uix";

// Budget: ~6 one-line rows fit in the left pane before HubSpot starts
// expanding and forcing whole-page scroll. Leave headroom for accordion
// headers, selection bar, and composer.
const COMMENTS_PAGE_SIZE = 5;
const MESSAGES_PAGE_SIZE = 5;
const CHAT_PANE_WIDTH = 380;
const COLLAPSED_CHAT_PANE_WIDTH = 80;

// Mock chat history for no-backend dev mode. Real history is fetched from the
// worker's GET /chats endpoint when BACKEND_ENABLED.
const MOCK_CHAT_HISTORY = [
  { id: "h-1", title: "First pass on deal summary", updatedAt: "2026-04-21T14:32:00Z" },
  { id: "h-2", title: "Added delay-cause breakdown", updatedAt: "2026-04-20T09:10:00Z" },
  { id: "h-3", title: "Exploring sidebar variant", updatedAt: "2026-04-18T16:05:00Z" },
];

export const ProjectPage = () => {
  const { params } = usePageRoute();
  const { projectId } = params;
  const { getProject, auth, renameProject, deleteProject } = useProjects();
  const { actions } = useExtensionApi();
  const { mountedRef, runTracked, runDetached, startDetached } = useEffectRunner();
  const chatService = useMemo(
    () =>
      createProjectPageChatService({
        auth,
        projectId,
        messagePageSize: MESSAGES_PAGE_SIZE,
        mountedRef,
        runTracked,
        runDetached,
        startDetached,
      }),
    [auth, mountedRef, projectId, runDetached, runTracked, startDetached],
  );
  const commentService = useMemo(
    () =>
      createProjectPageCommentService({
        auth,
        projectId,
        mountedRef,
        runDetached,
      }),
    [auth, mountedRef, projectId, runDetached],
  );
  const modalService = useMemo(
    () =>
      createProjectPageModalService({
        mountedRef,
        projectId,
        renameProject,
        deleteProject,
        closeOverlay: actions.closeOverlay,
        navigateToPage: (to) => actions.navigateToPage({ to }),
      }),
    [actions, deleteProject, mountedRef, projectId, renameProject],
  );
  const questionService = useMemo(() => createProjectPageQuestionService(), []);

  const project = getProject(projectId);
  const projectName = project?.name || `Project ${projectId}`;

  // Rename / delete state. Modals open via overlay props on the header
  // buttons; save/delete work fires on confirm.
  const [renameDraft, setRenameDraft] = useState(projectName);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [renameError, setRenameError] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  // Sync draft when the project name actually changes (e.g. after save).
  useEffect(() => {
    setRenameDraft(projectName);
  }, [projectName]);

  const handleRenameSave = async () => {
    return modalService.renameProject({
      renameDraft,
      projectName,
      isRenaming,
      setIsRenaming,
      setRenameError,
    });
  };

  const handleDeleteConfirm = async () => {
    return modalService.deleteProject({
      isDeleting,
      setIsDeleting,
      setDeleteError,
    });
  };
  const [chatId, setChatId] = useState(null);

  const [leftTab, setLeftTab] = useState("chat");
  const [commentMode, setCommentMode] = useState(false);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  // Remember the panel state from before entering comment mode so toggling
  // out restores the user's prior choice instead of always expanding.
  const prevLeftPanelCollapsedRef = useRef(false);
  const [comments, setComments] = useState([]);
  const [selectedCommentIds, setSelectedCommentIds] = useState(() => new Set());
  const [visibleOpenComments, setVisibleOpenComments] =
    useState(COMMENTS_PAGE_SIZE);
  const [visibleCompletedComments, setVisibleCompletedComments] =
    useState(COMMENTS_PAGE_SIZE);
  const [messages, setMessages] = useState([]);
  const [visibleMessages, setVisibleMessages] = useState(MESSAGES_PAGE_SIZE);
  // Server-side pagination state. messagesCursor = created_at of the oldest
  // message loaded; null once the server has confirmed we've hit the end.
  const [messagesCursor, setMessagesCursor] = useState(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const toggleHistory = useCallback(() => setHistoryOpen((v) => !v), []);
  // Backend-driven chat history for this project.
  const [chatHistory, setChatHistory] = useState([]);

  // activeStream tracks the currently-streaming assistant message, if any.
  const [activeStream, setActiveStream] = useState(null);
  // Set when the stream's 90s server-stall guard fires. The DO is dead and
  // resume polling won't recover; a page reload reattaches to a clean slate
  // and the persisted message stays in 'error' state. Cleared on next send.
  const [streamStalled, setStreamStalled] = useState(false);
  const [usageExhausted, setUsageExhausted] = useState(false);

  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});

  // Active spec is either a persisted spec loaded from the worker, or the
  // local demoSpec fallback when nothing's been generated yet. In backend
  // mode it's replaced on emit_spec via the stream poll response.
  const [initialDataLoaded, setInitialDataLoaded] = useState(!BACKEND_ENABLED);
  const [activeSpec, setActiveSpec] = useState(demoSpec);
  const [specState, setSpecState] = useState(() => ({
    ...(demoSpec.state || {}),
  }));
  // One-line summary of the last spec change, set by emit_spec's `note`.
  // Shown as microcopy under the Preview heading.
  const [specNote, setSpecNote] = useState(null);

  // When a new spec arrives, reset specState so the tweaks panel reflects
  // the spec's own initial state rather than inheriting stale values from a
  // prior spec (different viewMode enum, etc.).
  const applySpec = useCallback((spec, note) => {
    if (!spec || typeof spec !== "object") return;
    setActiveSpec(spec);
    setSpecState({ ...(spec.state || {}) });
    if (typeof note === "string" && note.length > 0) {
      setSpecNote(note);
    }
  }, []);

  // Phase-2: apply incoming RFC-6902 patches to the live spec. Each patch log
  // entry contains an `ops` array; we flatten them and run them against the
  // current spec. If `/state` ends up in the patched spec, mirror it into
  // specState so tweaks reflect what's on screen.
  const applyLivePatches = useCallback((log) => {
    setActiveSpec((prev) => {
      const flatOps = log.flatMap((e) => e.ops || []);
      if (flatOps.length === 0) return prev;
      const next = applyPatches(prev ?? {}, flatOps);
      if (next && next.state && next !== prev) {
        setSpecState({ ...(next.state || {}) });
      }
      return next;
    });
  }, []);

  const handleStateChange = useCallback((key, value) => {
    setSpecState((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Initial hydration from the worker: resolve chat thread id, pull messages
  // and comments. Skipped entirely in no-backend dev mode.
  useEffect(() => {
    if (!BACKEND_ENABLED || !projectId) {
      setInitialDataLoaded(true);
      return;
    }
    setInitialDataLoaded(false);
    return chatService.startHydration({
      applySpec,
      setChatId,
      setComments,
      setChatHistory,
      setMessages,
      setMessagesCursor,
      setHasMoreMessages,
      setActiveStream,
      setInitialDataLoaded,
    });
  }, [applySpec, chatService, projectId]);

  const loadMoreOpenComments = useCallback(() => {
    setVisibleOpenComments((n) => n + COMMENTS_PAGE_SIZE);
  }, []);
  const loadMoreCompletedComments = useCallback(() => {
    setVisibleCompletedComments((n) => n + COMMENTS_PAGE_SIZE);
  }, []);
  const loadMoreMessages = useCallback(async () => {
    if (!BACKEND_ENABLED) {
      setVisibleMessages((n) => n + MESSAGES_PAGE_SIZE);
      return;
    }
    return chatService.loadMoreMessages({
      chatId,
      messagesCursor,
      loadingOlder,
      setLoadingOlder,
      setMessages,
      setMessagesCursor,
      setHasMoreMessages,
    });
  }, [chatId, chatService, loadingOlder, messagesCursor]);

  // Switch the active thread. Loads that thread's most recent page and
  // resets all chat-local state.
  const selectChat = useCallback(
    async (nextChatId) => {
      if (!BACKEND_ENABLED || !nextChatId || nextChatId === chatId) {
        setHistoryOpen(false);
        return;
      }
      return chatService.selectChat({
        nextChatId,
        currentChatId: chatId,
        setChatId,
        setMessages,
        setMessagesCursor,
        setHasMoreMessages,
        setHistoryOpen,
      });
    },
    [chatId, chatService],
  );

  // Create a brand-new chat thread for this project and switch into it.
  const createNewChat = useCallback(async () => {
    if (!BACKEND_ENABLED) {
      setHistoryOpen(false);
      return;
    }
    return chatService.createNewChat({
      setChatHistory,
      setChatId,
      setMessages,
      setMessagesCursor,
      setHasMoreMessages,
      setHistoryOpen,
    });
  }, [chatService]);

  // Per-tab composer drafts live here so switching tabs preserves typed text.
  const [chatDraft, setChatDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");

  const handleChatSend = useCallback(
    async (text) => {
      if (!BACKEND_ENABLED) return;
      setStreamStalled(false);
      setUsageExhausted(false);
      return chatService.sendChat({
        text,
        chatId,
        setMessages,
        setActiveStream,
        setUsageExhausted,
      });
    },
    [chatId, chatService],
  );

  const addComment = useCallback(
    (nodeId, nodeSummary, text, { sendNow = false } = {}) => {
      if (!BACKEND_ENABLED) return;
      commentService.addComment({
        nodeId,
        nodeSummary,
        text,
        setComments,
        setLeftTab,
      });

      if (sendNow) {
        const target = nodeSummary ? `on **${nodeSummary}**` : "(general)";
        handleChatSend(`Addressing this comment:\n\n- ${target}: ${text}`);
        setLeftTab("chat");
      }
    },
    [commentService, handleChatSend],
  );

  const addGeneralComment = useCallback(
    (text) => {
      if (!BACKEND_ENABLED) return;
      commentService.addGeneralComment({ text, setComments });
    },
    [commentService],
  );

  const toggleCommentStatus = useCallback(
    (id) => {
      commentService.toggleCommentStatus({
        id,
        setComments,
        setSelectedCommentIds,
      });
    },
    [commentService],
  );

  const deleteComment = useCallback(
    (id) => {
      commentService.deleteComment({
        id,
        setComments,
        setSelectedCommentIds,
      });
    },
    [commentService],
  );

  const toggleCommentSelection = useCallback((id) => {
    setSelectedCommentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearCommentSelection = useCallback(() => {
    setSelectedCommentIds(new Set());
  }, []);

  const sendSelectedCommentsToChat = useCallback(() => {
    if (selectedCommentIds.size === 0 || usageExhausted) return;
    // Flip sent comments to 'completed'. Optimistic local update + backend
    // PATCH per comment; rollback on failure.
    commentService.sendSelectedCommentsToChat({
      comments,
      selectedCommentIds,
      handleChatSend,
      setComments,
      setSelectedCommentIds,
      setLeftTab,
    });
  }, [commentService, comments, handleChatSend, selectedCommentIds, usageExhausted]);

  const openCommentIds = useMemo(
    () =>
      comments
        .filter((comment) => comment.status !== "completed")
        .map((comment) => comment.id),
    [comments],
  );

  const selectAllOpenComments = useCallback(() => {
    if (openCommentIds.length === 0) return;
    setSelectedCommentIds(new Set(openCommentIds));
  }, [openCommentIds]);

  const sendAllOpenCommentsToChat = useCallback(() => {
    if (openCommentIds.length === 0 || usageExhausted) return;
    commentService.sendSelectedCommentsToChat({
      comments,
      selectedCommentIds: new Set(openCommentIds),
      handleChatSend,
      setComments,
      setSelectedCommentIds,
      setLeftTab,
    });
  }, [commentService, comments, handleChatSend, openCommentIds, usageExhausted]);

  const {
    phase: rawStreamPhase,
    phaseHistory: streamPhaseHistory,
    reconnecting: streamReconnecting,
  } = useStream({
    workerUrl: WORKER_URL,
    streamId: activeStream?.streamId,
    enabled: BACKEND_ENABLED && Boolean(activeStream),
    onChunk: (append) => {
      const targetId = activeStream?.messageId;
      if (!targetId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === targetId ? { ...m, content: m.content + append } : m,
        ),
      );
    },
    onSpec: (spec, note) => {
      // Mid-turn: emit_skeleton lands first, then each patch_spec. Apply
      // as we go so the canvas shows progress instead of sitting empty
      // until the whole turn completes. This is the authoritative path —
      // the full spec replaces whatever the incremental patches built.
      applySpec(spec, note);
    },
    onPatches: (log) => {
      // Phase-2: RFC-6902 ops stream in as tool-call arguments complete
      // element-by-element. Apply progressively so the card builds up on
      // screen instead of popping in 10-30s later.
      applyLivePatches(log);
    },
    onDone: (data) => {
      const targetId = activeStream?.messageId;
      if (targetId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === targetId ? { ...m, status: "done" } : m,
          ),
        );
      }
      if (data?.spec) applySpec(data.spec, data?.specNote);
      questionService.receiveQuestions({
        questions: data?.questions,
        setQuestions,
        setAnswers,
      });
      setActiveStream(null);
    },
    onError: (err) => {
      console.error("[chat] stream error:", err);
      if (err?.message === "stream stalled") {
        setStreamStalled(true);
      }
      const targetId = activeStream?.messageId;
      if (targetId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === targetId
              ? { ...m, status: "error", content: m.content || "(error)" }
              : m,
          ),
        );
        // Persist the error in D1 so the row doesn't stay 'streaming'
        // forever — otherwise the next reload would re-enter the
        // resume-polling path against a dead DO and stall again.
        if (BACKEND_ENABLED) {
          chatService.persistFailedMessage(targetId);
        }
      }
      setActiveStream(null);
    },
  });

  const handleAnswerChange = useCallback((questionId, value) => {
    questionService.updateAnswer({ questionId, value, setAnswers });
  }, [questionService]);

  const handleSubmitAnswers = useCallback(() => {
    questionService.submitAnswers({
      questions,
      answers,
      formatAnswersAsMessage,
      handleChatSend,
      setQuestions,
      setAnswers,
      setLeftTab,
    });
  }, [answers, handleChatSend, questionService, questions]);

  const handleSkipQuestions = useCallback(() => {
    questionService.skipQuestions({ setQuestions, setAnswers });
  }, [questionService]);

  const commentsTabTitle =
    comments.length > 0 ? `Comments (${comments.length})` : "Comments";
  const previewIsEmpty = activeSpec === demoSpec && questions.length === 0;

  return (
    <Flex direction="column" gap="md">
      <PageBreadcrumbs>
        <PageBreadcrumbs.PageLink to="/">Studio</PageBreadcrumbs.PageLink>
        <PageBreadcrumbs.Current>{projectName}</PageBreadcrumbs.Current>
      </PageBreadcrumbs>
      <Inline gap="sm" align="center">
        <Heading>{projectName}</Heading>
        <Button
          variant="transparent"
          size="extra-small"
          title="Rename"
          overlay={
            <Modal id={`rename-${projectId}`} title="Rename project" width="sm">
              <ModalBody>
                <Flex direction="column" gap="sm">
                  <Input
                    label="Project name"
                    name="rename-input"
                    value={renameDraft}
                    onInput={setRenameDraft}
                    required={true}
                  />
                  {renameError && (
                    <Alert variant="error" title="Rename failed">
                      <Text>{renameError}</Text>
                    </Alert>
                  )}
                </Flex>
              </ModalBody>
              <ModalFooter>
                <Flex direction="row" justify="end" gap="sm">
                  <Button
                    variant="secondary"
                    onClick={() => actions.closeOverlay(`rename-${projectId}`)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={
                      isRenaming ||
                      !renameDraft.trim() ||
                      renameDraft.trim() === projectName
                    }
                    onClick={handleRenameSave}
                  >
                    {isRenaming ? "Saving…" : "Save"}
                  </Button>
                </Flex>
              </ModalFooter>
            </Modal>
          }
        >
          <Icon name="edit" size="small" />
        </Button>
        <Button
          variant="transparent"
          size="extra-small"
          title="Delete"
          overlay={
            <Modal id={`delete-${projectId}`} title="Delete this project?" width="sm">
              <ModalBody>
                <Flex direction="column" gap="sm">
                  <Text>
                    You're about to delete{" "}
                    <Text inline={true} format={{ fontWeight: "demibold" }}>
                      {projectName}
                    </Text>
                    . This removes the spec, all chat history, and all comments.
                    It can't be undone.
                  </Text>
                  {deleteError && (
                    <Alert variant="error" title="Delete failed">
                      <Text>{deleteError}</Text>
                    </Alert>
                  )}
                </Flex>
              </ModalBody>
              <ModalFooter>
                <Flex direction="row" justify="end" gap="sm">
                  <Button
                    variant="secondary"
                    onClick={() => actions.closeOverlay(`delete-${projectId}`)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={isDeleting}
                    onClick={handleDeleteConfirm}
                  >
                    {isDeleting ? "Deleting…" : "Delete project"}
                  </Button>
                </Flex>
              </ModalFooter>
            </Modal>
          }
        >
          <Icon name="delete" size="small" />
        </Button>
      </Inline>

      {!initialDataLoaded ? (
        <Tile compact={true}>
          <Flex direction="row" align="center" justify="center" gap="xs">
            <LoadingSpinner size="xs" />
            <Text variant="microcopy">Loading project…</Text>
          </Flex>
        </Tile>
      ) : (
      <Flex direction="row" gap="md" align="stretch">
        {leftPanelCollapsed ? (
          <Box flex="none" alignSelf="stretch">
            <AutoGrid columnWidth={COLLAPSED_CHAT_PANE_WIDTH} gap="flush" flexible={false}>
              <Tile compact={true}>
                <Flex direction="column" gap="sm" align="center">
                  <Button
                    variant="transparent"
                    size="sm"
                    onClick={() => setLeftPanelCollapsed(false)}
                    tooltip="Expand chat and comments"
                  >
                    <Icon
                      name="right"
                      size="sm"
                      screenReaderText="Expand chat and comments panel"
                    />
                  </Button>
                  <StyledText
                    text="Chat / comments"
                    orientation="vertical-down"
                    variant="bodytext"
                  />
                </Flex>
              </Tile>
            </AutoGrid>
          </Box>
        ) : (
          // Fixed-width sidebar once a preview exists. Before the first spec,
          // let chat/comments share the workspace 50/50 with the empty preview.
          <Box flex={previewIsEmpty ? 1 : "none"} alignSelf="stretch">
            <AutoGrid
              columnWidth={CHAT_PANE_WIDTH}
              gap="flush"
              flexible={previewIsEmpty}
            >
              <Tile compact={true}>
              <Flex direction="column" gap="sm">
                <Flex direction="row" justify="between" align="start" gap="xs">
                  <Box flex={1}>
                    <Tabs selected={leftTab} onSelectedChange={setLeftTab}>
                      <Tab tabId="chat" title="Chat" gap="sm" />
                      <Tab tabId="comments" title={commentsTabTitle} gap="sm" />
                    </Tabs>
                  </Box>
                  <Button
                    variant="transparent"
                    onClick={() => setLeftPanelCollapsed(true)}
                    tooltip="Collapse chat and comments"
                  >
                    <Icon
                      name="left"
                      size="sm"
                      screenReaderText="Collapse chat and comments panel"
                    />
                  </Button>
                </Flex>
                {leftTab === "chat" && (
                  <ChatPanel
                    // Same Tabs-cache workaround as before — key-bust the
                    // panel when chat data shape changes so a fresh mount
                    // picks up async-loaded messages reliably.
                    key={`chat-${messages.length === 0 ? "empty" : "loaded"}-${historyOpen ? "h" : "m"}`}
                    messages={messages}
                    hasMore={hasMoreMessages}
                    onLoadMore={loadMoreMessages}
                    isLoadingMore={loadingOlder}
                    historyOpen={historyOpen}
                    history={BACKEND_ENABLED ? chatHistory : MOCK_CHAT_HISTORY}
                    activeChatId={chatId}
                    onSelectHistory={selectChat}
                    onNewChat={BACKEND_ENABLED ? createNewChat : undefined}
                    streamingMessageId={activeStream?.messageId}
                    streamPhase={streamReconnecting ? "Reconnecting" : rawStreamPhase}
                    streamPhaseHistory={streamPhaseHistory}
                    streamStalled={streamStalled}
                    usageExhausted={usageExhausted}
                    onReload={() => actions.reloadPage?.()}
                    onOpenSettings={() => actions.navigateToPage({ to: "/settings" })}
                  />
                )}
                {leftTab === "comments" && (
                  <CommentsPanel
                    key={`comments-${comments.length === 0 ? "empty" : "loaded"}`}
                    comments={comments}
                    selectedIds={selectedCommentIds}
                    visibleOpen={visibleOpenComments}
                    visibleCompleted={visibleCompletedComments}
                    onLoadMoreOpen={loadMoreOpenComments}
                    onLoadMoreCompleted={loadMoreCompletedComments}
                    onToggleStatus={toggleCommentStatus}
                    onDelete={deleteComment}
                    onToggleSelect={toggleCommentSelection}
                  />
                )}
                {leftTab === "chat" && !historyOpen && messages.length === 0 && (
                  <EmptyState
                    title="No messages yet"
                    layout="vertical"
                    reverseOrder={true}
                    flush={true}
                    imageName="idea"
                    imageWidth={170}
                  >
                    <Flex direction="column" gap="xs">
                      <Text>
                        Describe the card you want. Studio will start building
                        the spec, and your preview will appear on the right as
                        it generates.
                      </Text>
                      <Text>
                        You can also paste sample JSON, endpoint output, or
                        existing data and ask Studio to turn it into a card.
                      </Text>
                    </Flex>
                  </EmptyState>
                )}
                {leftTab === "comments" && comments.length === 0 && (
                  <EmptyState
                    title="No comments yet"
                    layout="vertical"
                    reverseOrder={true}
                    flush={true}
                    imageName="idea"
                    imageWidth={170}
                  >
                    <Text>
                      Turn on Comment mode in the preview to annotate specific
                      elements, or add a general comment below.
                    </Text>
                  </EmptyState>
                )}
                {leftTab === "chat" && (
                  <Composer
                    value={chatDraft}
                    onChange={setChatDraft}
                    label="Message"
                    name="chat-message"
                    placeholder="Describe what you want to create..."
                    onSend={handleChatSend}
                    sendLabel={commentMode ? "Comment" : "Send"}
                    rows={previewIsEmpty ? 8 : 4}
                    disabled={usageExhausted}
                    historyOpen={historyOpen}
                    onToggleHistory={toggleHistory}
                  />
                )}
                {leftTab === "comments" && (
                  <Flex direction="column" gap="xs">
                    {selectedCommentIds.size > 0 ? (
                      <Flex direction="column" gap="xs">
                        <Flex
                          direction="row"
                          justify="between"
                          align="center"
                          gap="xs"
                        >
                          <Inline gap="sm" align="center">
                            <Text variant="microcopy">
                              {selectedCommentIds.size} selected
                            </Text>
                            {openCommentIds.length > selectedCommentIds.size && (
                              <Link onClick={selectAllOpenComments}>
                                Select all
                              </Link>
                            )}
                          </Inline>
                          <Link onClick={clearCommentSelection}>Clear</Link>
                        </Flex>
                        <Flex direction="row" justify="end" align="center">
                          <Button
                            variant="primary"
                            size="xs"
                            onClick={sendSelectedCommentsToChat}
                            disabled={usageExhausted}
                          >
                            Send selected
                          </Button>
                        </Flex>
                      </Flex>
                    ) : (
                      openCommentIds.length > 0 && (
                        <Flex
                          direction="row"
                          justify="between"
                          align="center"
                          gap="xs"
                        >
                          <Text variant="microcopy">
                            {openCommentIds.length} pending comment
                            {openCommentIds.length === 1 ? "" : "s"}
                          </Text>
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={sendAllOpenCommentsToChat}
                            disabled={usageExhausted}
                          >
                            Send all to chat
                          </Button>
                        </Flex>
                      )
                    )}
                    <Composer
                      value={commentDraft}
                      onChange={setCommentDraft}
                      label="Comment"
                      name="general-comment"
                      placeholder="Add a general comment..."
                      onSend={addGeneralComment}
                      sendLabel="Comment"
                    />
                  </Flex>
                )}
              </Flex>
              </Tile>
            </AutoGrid>
          </Box>
        )}

        <Box flex={1} alignSelf="stretch">
          <Tile compact={true}>
            {questions.length > 0 ? (
              <QuestionsPanel
                questions={questions}
                answers={answers}
                onAnswerChange={handleAnswerChange}
                onSubmit={handleSubmitAnswers}
                onSkip={handleSkipQuestions}
              />
            ) : (
              <Flex direction="column" gap="sm">
                <Flex direction="row" justify="between" align="end">
                  <Flex direction="column" gap="flush">
                    <Heading>{commentMode ? "Comment mode" : "Preview"}</Heading>
                    {specNote && !commentMode && (
                      <Text variant="microcopy">{specNote}</Text>
                    )}
                  </Flex>
                  <Flex direction="row" justify="end" align="center">
                    <Inline gap="sm">
                      {commentMode && (
                        <Link
                          onClick={() => {
                            setCommentMode(false);
                            setLeftPanelCollapsed(prevLeftPanelCollapsedRef.current);
                          }}
                        >
                          <Icon
                            name="xCircle"
                            size="sm"
                            color="alert"
                            screenReaderText="Exit comment mode"
                          />
                        </Link>
                      )}
                      {!commentMode && (
                        <Link
                          onClick={() => {
                            prevLeftPanelCollapsedRef.current = leftPanelCollapsed;
                            setLeftPanelCollapsed(true);
                            setCommentMode(true);
                          }}
                        >
                          <Icon
                            name="comment"
                            size="sm"
                            color="inherit"
                            screenReaderText="Enter comment mode"
                          />
                        </Link>
                      )}
                      <Link
                        overlay={
                          <TweaksPanel
                            spec={activeSpec}
                            state={specState}
                            onStateChange={handleStateChange}
                          />
                        }
                      >
                        <Icon
                          name="filter"
                          size="sm"
                          screenReaderText="Tweak preview"
                        />
                      </Link>
                      <Link overlay={<ExportPanel spec={activeSpec} projectId={projectId} />}>
                        <Icon
                          name="download"
                          size="sm"
                          screenReaderText="Export"
                        />
                      </Link>
                    </Inline>
                  </Flex>
                </Flex>
                <Divider size="flush" />
                <Box flex={1}>
                  <Flex direction="column" gap="sm">
                    <PreviewToasts />
                    {activeSpec === demoSpec ? (
                      <EmptyState
                        title="Nothing to preview yet"
                        layout="vertical"
                        imageName="components"
                        imageWidth={170}
                        reverseOrder={true}
                      >
                        <Text>
                          Your card preview will appear here once Studio has a
                          spec to render.
                        </Text>
                      </EmptyState>
                    ) : (
                      <Canvas
                        spec={activeSpec}
                        state={specState}
                        onStateChange={handleStateChange}
                        commentMode={commentMode}
                        comments={comments}
                        onAddComment={addComment}
                        actions={actions}
                      />
                    )}
                  </Flex>
                </Box>
              </Flex>
            )}
          </Tile>
        </Box>
      </Flex>
      )}
    </Flex>
  );
};
