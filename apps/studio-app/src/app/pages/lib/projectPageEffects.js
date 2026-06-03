import { Effect } from "effect";

import { workerApi } from "./worker.js";

export function normalizeComment(comment) {
  return {
    id: comment.id,
    nodeId: comment.node_id,
    nodeSummary: comment.node_summary,
    text: comment.text,
    status: comment.status,
    createdAt: new Date(comment.created_at).toISOString(),
  };
}

export function normalizeMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: new Date(message.created_at).toISOString(),
  };
}

export function normalizeChatHistoryEntry(chat) {
  return {
    id: chat.id,
    title: chat.title,
    updatedAt: new Date(chat.updated_at).toISOString(),
  };
}

export const loadProjectPageDataEffect = (auth, projectId, messageLimit) =>
  Effect.gen(function* () {
    const [detail, commentRes, chatRes] = yield* Effect.tryPromise(() =>
      Promise.all([
        workerApi.getProject(auth, projectId),
        workerApi.listComments(auth, projectId),
        workerApi.listChats(auth, projectId),
      ]),
    );

    const resolvedChatId = detail?.defaultChatId ?? null;
    const comments = (commentRes?.comments ?? []).map(normalizeComment);
    const chatHistory = (chatRes?.chats ?? []).map(normalizeChatHistoryEntry);

    if (!resolvedChatId) {
      return {
        detail,
        resolvedChatId,
        comments,
        chatHistory,
        messages: [],
        nextCursor: null,
        resumedStream: null,
      };
    }

    const msgRes = yield* Effect.tryPromise(() =>
      workerApi.listMessages(auth, resolvedChatId, {
        limit: messageLimit,
      }),
    );

    const rows = (msgRes?.messages ?? []).slice().reverse();
    const resumed = rows
      .filter((message) => message.role === "assistant" && message.status === "streaming")
      .pop();

    return {
      detail,
      resolvedChatId,
      comments,
      chatHistory,
      messages: rows.map(normalizeMessage),
      nextCursor: msgRes?.nextCursor ?? null,
      resumedStream: resumed
        ? {
            streamId: resumed.id,
            messageId: resumed.id,
          }
        : null,
    };
  });

export const listChatMessagesEffect = (auth, chatId, { cursor, limit }) =>
  Effect.tryPromise(() => workerApi.listMessages(auth, chatId, { cursor, limit })).pipe(
    Effect.map((res) => ({
      messages: (res?.messages ?? []).slice().reverse().map(normalizeMessage),
      nextCursor: res?.nextCursor ?? null,
    })),
  );

export const createChatEffect = (auth, projectId) =>
  Effect.tryPromise(() => workerApi.createChat(auth, { projectId })).pipe(
    Effect.map((res) => {
      const created = res?.chat;
      return created
        ? {
            chat: normalizeChatHistoryEntry(created),
          }
        : { chat: null };
    }),
  );

export const createCommentEffect = (auth, payload) =>
  Effect.tryPromise(() => workerApi.createComment(auth, payload)).pipe(
    Effect.map((res) => res?.comment?.id ?? null),
  );

export const patchCommentStatusEffect = (auth, commentId, status) =>
  Effect.tryPromise(() => workerApi.patchCommentStatus(auth, commentId, status));

export const deleteCommentEffect = (auth, commentId) =>
  Effect.tryPromise(() => workerApi.deleteComment(auth, commentId));

export const postChatEffect = (auth, payload) =>
  Effect.tryPromise(() => workerApi.postChat(auth, payload));

export const failMessageEffect = (auth, messageId) =>
  Effect.tryPromise(() => workerApi.failMessage(auth, messageId));
