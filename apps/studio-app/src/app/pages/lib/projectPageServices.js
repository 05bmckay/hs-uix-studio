import { Effect } from "effect";

import {
  createChatEffect,
  createCommentEffect,
  deleteCommentEffect,
  failMessageEffect,
  listChatMessagesEffect,
  loadProjectPageDataEffect,
  patchCommentStatusEffect,
  postChatEffect,
} from "./projectPageEffects.js";

export function createProjectPageChatService({
  auth,
  projectId,
  messagePageSize,
  mountedRef,
  runTracked,
  runDetached,
  startDetached,
}) {
  return {
    startHydration({
      applySpec,
      setChatId,
      setComments,
      setChatHistory,
      setMessages,
      setMessagesCursor,
      setHasMoreMessages,
      setActiveStream,
      setInitialDataLoaded,
    }) {
      return startDetached(
        loadProjectPageDataEffect(auth, projectId, messagePageSize).pipe(
          Effect.tap((pageData) =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setChatId(pageData.resolvedChatId);
              if (pageData.detail?.spec) applySpec(pageData.detail.spec);
              setComments(pageData.comments);
              setChatHistory(pageData.chatHistory);
              setMessages(pageData.messages);
              setMessagesCursor(pageData.nextCursor);
              setHasMoreMessages(Boolean(pageData.nextCursor));
              if (pageData.resumedStream) {
                setActiveStream(pageData.resumedStream);
              }
              setInitialDataLoaded?.(true);
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              if (mountedRef.current) {
                console.error("[project] load failed:", err);
                setInitialDataLoaded?.(true);
              }
            }),
          ),
        ),
      );
    },

    loadMoreMessages({
      chatId,
      messagesCursor,
      loadingOlder,
      setLoadingOlder,
      setMessages,
      setMessagesCursor,
      setHasMoreMessages,
    }) {
      if (!chatId || !messagesCursor || loadingOlder) return Promise.resolve();
      setLoadingOlder(true);
      return runTracked(
        listChatMessagesEffect(auth, chatId, {
          cursor: messagesCursor,
          limit: messagePageSize,
        }).pipe(
          Effect.tap((res) =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setMessages((prev) => [...res.messages, ...prev]);
              setMessagesCursor(res.nextCursor);
              setHasMoreMessages(Boolean(res.nextCursor));
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              console.error("[chat] load older failed:", err);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (mountedRef.current) setLoadingOlder(false);
            }),
          ),
        ),
      );
    },

    selectChat({
      nextChatId,
      currentChatId,
      setChatId,
      setMessages,
      setMessagesCursor,
      setHasMoreMessages,
      setHistoryOpen,
    }) {
      if (!nextChatId || nextChatId === currentChatId) {
        setHistoryOpen(false);
        return Promise.resolve();
      }
      setChatId(nextChatId);
      setMessages([]);
      setMessagesCursor(null);
      setHasMoreMessages(false);
      setHistoryOpen(false);

      return runTracked(
        listChatMessagesEffect(auth, nextChatId, {
          limit: messagePageSize,
        }).pipe(
          Effect.tap((res) =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setMessages(res.messages);
              setMessagesCursor(res.nextCursor);
              setHasMoreMessages(Boolean(res.nextCursor));
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              console.error("[chat] switch failed:", err);
            }),
          ),
        ),
      );
    },

    createNewChat({
      setChatHistory,
      setChatId,
      setMessages,
      setMessagesCursor,
      setHasMoreMessages,
      setHistoryOpen,
    }) {
      return runTracked(
        createChatEffect(auth, projectId).pipe(
          Effect.tap((res) =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              const created = res.chat;
              if (!created) return;
              setChatHistory((prev) => [created, ...prev]);
              setChatId(created.id);
              setMessages([]);
              setMessagesCursor(null);
              setHasMoreMessages(false);
              setHistoryOpen(false);
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              console.error("[chat] new thread failed:", err);
            }),
          ),
        ),
      );
    },

    sendChat({ text, chatId, setMessages, setActiveStream, setUsageExhausted }) {
      const localUserId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const userMsg = {
        id: localUserId,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      if (!chatId) {
        console.warn("[chat] no chatId yet — project detail hasn't loaded");
        return Promise.resolve();
      }

      return runTracked(
        postChatEffect(auth, { projectId, chatId, userMessage: text }).pipe(
          Effect.tap(({ streamId, messageId }) =>
            Effect.sync(() => {
              if (!mountedRef.current) return;
              setMessages((prev) => [
                ...prev,
                {
                  id: messageId,
                  role: "assistant",
                  content: "",
                  status: "streaming",
                  createdAt: new Date().toISOString(),
                },
              ]);
              setActiveStream({ streamId, messageId });
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              console.error("[chat] send failed:", err);
              if (!mountedRef.current) return;

              const isCreditExhausted =
                err?.code === "credit_exhausted" || err?.status === 402;
              if (isCreditExhausted) setUsageExhausted?.(true);

              const body = err?.message || String(err);
              const content = isCreditExhausted
                ? `<i>${body}</i>`
                : `<i>Couldn't reach the Studio backend. ${body}</i>`;

              setMessages((prev) => [
                ...prev,
                {
                  id: `m-err-${Date.now().toString(36)}`,
                  role: "system",
                  content,
                  createdAt: new Date().toISOString(),
                },
              ]);
            }),
          ),
        ),
      );
    },

    persistFailedMessage(targetId) {
      return runDetached(
        failMessageEffect(auth, targetId).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error("[chat] failMessage failed:", error);
            }),
          ),
        ),
      );
    },
  };
}

export function createProjectPageCommentService({
  auth,
  projectId,
  mountedRef,
  runDetached,
}) {
  return {
    addComment({ nodeId, nodeSummary, text, setComments, setLeftTab }) {
      const tempId = `c-tmp-${Date.now().toString(36)}`;
      const comment = {
        id: tempId,
        nodeId,
        nodeSummary,
        text,
        status: "open",
        createdAt: new Date().toISOString(),
      };
      setComments((prev) => [comment, ...prev]);
      setLeftTab("comments");

      runDetached(
        createCommentEffect(auth, { projectId, nodeId, nodeSummary, text }).pipe(
          Effect.tap((commentId) =>
            Effect.sync(() => {
              if (!mountedRef.current || !commentId) return;
              setComments((prev) =>
                prev.map((entry) =>
                  entry.id === tempId ? { ...entry, id: commentId } : entry,
                ),
              );
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error("[comments] create failed:", error);
              if (!mountedRef.current) return;
              setComments((prev) => prev.filter((entry) => entry.id !== tempId));
            }),
          ),
        ),
      );
    },

    addGeneralComment({ text, setComments }) {
      const tempId = `c-tmp-${Date.now().toString(36)}`;
      const comment = {
        id: tempId,
        nodeId: null,
        nodeSummary: null,
        text,
        status: "open",
        createdAt: new Date().toISOString(),
      };
      setComments((prev) => [comment, ...prev]);

      runDetached(
        createCommentEffect(auth, {
          projectId,
          nodeId: null,
          nodeSummary: null,
          text,
        }).pipe(
          Effect.tap((commentId) =>
            Effect.sync(() => {
              if (!mountedRef.current || !commentId) return;
              setComments((prev) =>
                prev.map((entry) =>
                  entry.id === tempId ? { ...entry, id: commentId } : entry,
                ),
              );
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error("[comments] create failed:", error);
              if (!mountedRef.current) return;
              setComments((prev) => prev.filter((entry) => entry.id !== tempId));
            }),
          ),
        ),
      );
    },

    toggleCommentStatus({ id, setComments, setSelectedCommentIds }) {
      let becameCompleted = false;
      let prevStatus = null;
      setComments((prev) =>
        prev.map((comment) => {
          if (comment.id !== id) return comment;
          prevStatus = comment.status;
          const nextStatus = comment.status === "completed" ? "open" : "completed";
          if (nextStatus === "completed") becameCompleted = true;
          return { ...comment, status: nextStatus };
        }),
      );

      if (becameCompleted) {
        setSelectedCommentIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }

      if (id.startsWith("c-tmp-")) return;
      const nextStatus = prevStatus === "completed" ? "open" : "completed";
      runDetached(
        patchCommentStatusEffect(auth, id, nextStatus).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error("[comments] status sync failed:", error);
              if (!mountedRef.current) return;
              setComments((prev) =>
                prev.map((comment) =>
                  comment.id === id ? { ...comment, status: prevStatus } : comment,
                ),
              );
            }),
          ),
        ),
      );
    },

    deleteComment({ id, setComments, setSelectedCommentIds }) {
      let removed = null;
      setComments((prev) => {
        removed = prev.find((comment) => comment.id === id) ?? null;
        return prev.filter((comment) => comment.id !== id);
      });
      setSelectedCommentIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });

      if (id.startsWith("c-tmp-")) return;
      runDetached(
        deleteCommentEffect(auth, id).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error("[comments] delete failed:", error);
              if (!mountedRef.current || !removed) return;
              setComments((prev) => [removed, ...prev]);
            }),
          ),
        ),
      );
    },

    sendSelectedCommentsToChat({
      comments,
      selectedCommentIds,
      handleChatSend,
      setComments,
      setSelectedCommentIds,
      setLeftTab,
    }) {
      if (selectedCommentIds.size === 0) return;
      const picked = comments.filter((comment) => selectedCommentIds.has(comment.id));
      if (picked.length === 0) return;

      const intro =
        picked.length === 1
          ? "Addressing this comment:"
          : `Addressing these ${picked.length} comments:`;
      const body = picked
        .map((comment) => {
          const target = comment.nodeSummary ? `on **${comment.nodeSummary}**` : "(general)";
          return `- ${target}: ${comment.text}`;
        })
        .join("\n");

      handleChatSend(`${intro}\n\n${body}`);

      const openIds = picked
        .filter((comment) => comment.status !== "completed")
        .map((comment) => comment.id);

      setComments((prev) =>
        prev.map((comment) =>
          openIds.includes(comment.id) ? { ...comment, status: "completed" } : comment,
        ),
      );

      for (const id of openIds) {
        if (id.startsWith("c-tmp-")) continue;
        runDetached(
          patchCommentStatusEffect(auth, id, "completed").pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                console.error("[comments] auto-complete failed:", error);
                if (!mountedRef.current) return;
                setComments((prev) =>
                  prev.map((comment) =>
                    comment.id === id ? { ...comment, status: "open" } : comment,
                  ),
                );
              }),
            ),
          ),
        );
      }

      setSelectedCommentIds(new Set());
      setLeftTab("chat");
    },
  };
}

export function createProjectPageModalService({
  mountedRef,
  projectId,
  renameProject,
  deleteProject,
  closeOverlay,
  navigateToPage,
}) {
  return {
    async renameProject({
      renameDraft,
      projectName,
      isRenaming,
      setIsRenaming,
      setRenameError,
    }) {
      const next = renameDraft.trim();
      if (!next || next === projectName || isRenaming) return;
      setIsRenaming(true);
      setRenameError(null);
      try {
        await renameProject(projectId, next);
        closeOverlay(`rename-${projectId}`);
      } catch (error) {
        if (mountedRef.current) setRenameError(error.message || String(error));
      } finally {
        if (mountedRef.current) setIsRenaming(false);
      }
    },

    async deleteProject({
      isDeleting,
      setIsDeleting,
      setDeleteError,
    }) {
      if (isDeleting) return;
      setIsDeleting(true);
      setDeleteError(null);
      try {
        await deleteProject(projectId);
        closeOverlay(`delete-${projectId}`);
        navigateToPage("/");
      } catch (error) {
        if (mountedRef.current) {
          setDeleteError(error.message || String(error));
          setIsDeleting(false);
        }
      }
    },
  };
}

export function createProjectPageQuestionService() {
  return {
    receiveQuestions({ questions, setQuestions, setAnswers }) {
      if (!Array.isArray(questions) || questions.length === 0) return;
      setQuestions(questions);
      setAnswers({});
    },

    updateAnswer({ questionId, value, setAnswers }) {
      setAnswers((prev) => ({ ...prev, [questionId]: value }));
    },

    submitAnswers({
      questions,
      answers,
      formatAnswersAsMessage,
      handleChatSend,
      setQuestions,
      setAnswers,
      setLeftTab,
    }) {
      const body = formatAnswersAsMessage(questions, answers);
      setQuestions([]);
      setAnswers({});
      setLeftTab("chat");
      if (!body) return;
      handleChatSend(`Answers to clarifying questions:\n\n${body}`);
    },

    skipQuestions({ setQuestions, setAnswers }) {
      setQuestions([]);
      setAnswers({});
    },
  };
}
