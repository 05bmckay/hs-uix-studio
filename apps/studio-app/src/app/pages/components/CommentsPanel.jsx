import React from "react";
import {
  Accordion,
  Checkbox,
  Flex,
  Icon,
  Inline,
  Link,
  Modal,
  ModalBody,
  Tag,
  Text,
  Tile,
  Tooltip,
} from "@hubspot/ui-extensions";

// Shows captured comments split into In progress / Completed accordions.
// Each comment has inline actions to toggle its status or delete it.
// The general-comment composer lives outside Tab content in ProjectPage.
export const CommentsPanel = ({
  comments = [],
  selectedIds,
  visibleOpen,
  visibleCompleted,
  onLoadMoreOpen,
  onLoadMoreCompleted,
  onToggleStatus,
  onDelete,
  onToggleSelect,
}) => {
  const selected = selectedIds || new Set();
  if (comments.length === 0) {
    // Empty state lives outside the tab body in ProjectPage so its centering
    // isn't squeezed by the tab content layout.
    return null;
  }

  const openComments = comments.filter((c) => c.status !== "completed");
  const completedComments = comments.filter((c) => c.status === "completed");

  const openTitle =
    openComments.length > 0
      ? `Queued (${openComments.length})`
      : "Queued";
  const completedTitle =
    completedComments.length > 0
      ? `Completed (${completedComments.length})`
      : "Completed";

  return (
    <Flex direction="column" gap="sm" justify="start">
      <Accordion title={openTitle} size="sm" defaultOpen={true}>
        <CommentGroup
          comments={openComments}
          emptyText="No open comments."
          selected={selected}
          visibleCount={visibleOpen}
          onLoadMore={onLoadMoreOpen}
          onToggleStatus={onToggleStatus}
          onDelete={onDelete}
          onToggleSelect={onToggleSelect}
        />
      </Accordion>
      <Accordion title={completedTitle} size="sm" defaultOpen={false}>
        <CommentGroup
          comments={completedComments}
          emptyText="No completed comments."
          selected={selected}
          visibleCount={visibleCompleted}
          onLoadMore={onLoadMoreCompleted}
          onToggleStatus={onToggleStatus}
          onDelete={onDelete}
          onToggleSelect={onToggleSelect}
        />
      </Accordion>
    </Flex>
  );
};

const CommentGroup = ({
  comments,
  emptyText,
  selected,
  visibleCount,
  onLoadMore,
  onToggleStatus,
  onDelete,
  onToggleSelect,
}) => {
  if (comments.length === 0) {
    return <Text variant="microcopy">{emptyText}</Text>;
  }
  const cap =
    typeof visibleCount === "number" ? visibleCount : comments.length;
  const hidden = Math.max(0, comments.length - cap);
  const visible = hidden > 0 ? comments.slice(0, cap) : comments;
  return (
    <Flex direction="column" gap="xs">
      {visible.map((c) => (
        <CommentCard
          key={c.id}
          comment={c}
          isSelected={selected?.has(c.id)}
          onToggleStatus={onToggleStatus}
          onDelete={onDelete}
          onToggleSelect={onToggleSelect}
        />
      ))}
      {hidden > 0 && onLoadMore && (
        <Flex direction="row" justify="center">
          <Link onClick={onLoadMore}>
            See {Math.min(hidden, cap)} more
          </Link>
        </Flex>
      )}
    </Flex>
  );
};

const CommentCard = ({
  comment,
  isSelected,
  onToggleStatus,
  onDelete,
  onToggleSelect,
}) => {
  const isCompleted = comment.status === "completed";
  const full = comment.nodeSummary || "General";
  const shown = truncateMiddle(full);
  const text = comment.text || "";
  const isLongText = text.length > 40;
  const shownText = isLongText ? `${text.slice(0, 40)}…` : text;

  const footer = (
    <Flex direction="row" justify="between" align="center">
      <Text variant="microcopy">{formatTimestamp(comment.createdAt)}</Text>
      <Inline gap="sm">
        <Link onClick={() => onToggleStatus?.(comment.id)}>
          <Icon
            name={isCompleted ? "checkCircle" : "circleHollow"}
            size="sm"
            color={isCompleted ? "success" : "inherit"}
            screenReaderText={
              isCompleted ? "Uncheck comment" : "Mark complete"
            }
          />
        </Link>
        <Link onClick={() => onDelete?.(comment.id)}>
          <Icon name="delete" size="sm" screenReaderText="Delete comment" />
        </Link>
      </Inline>
    </Flex>
  );

  const selectCheckbox =
    onToggleSelect && !isCompleted ? (
      <Checkbox
        name={`select-${comment.id}`}
        checked={!!isSelected}
        variant="small"
        onChange={() => onToggleSelect(comment.id)}
      />
    ) : null;

  return (
    <Tile compact={true}>
      <Flex direction="column" gap="flush">
        <Flex direction="row" justify="between" align="center" gap="sm">
          <Tag
            variant="default"
            overlay={shown !== full ? <Tooltip>{full}</Tooltip> : undefined}
          >
            {shown}
          </Tag>
          {selectCheckbox}
        </Flex>
        <Text>{shownText}</Text>
        {isLongText && (
          <Link
            overlay={
              <Modal
                id={`comment-detail-${comment.id}`}
                title="Comment"
                width="md"
              >
                <ModalBody>
                  <Flex direction="column" gap="sm">
                    <Tag variant="default">{full}</Tag>
                    <Text>{text}</Text>
                  </Flex>
                </ModalBody>
              </Modal>
            }
          >
            Show more
          </Link>
        )}
        {footer}
      </Flex>
    </Tile>
  );
};

function truncateMiddle(text, maxLen = 28) {
  if (!text || text.length <= maxLen) return text;
  const keep = maxLen - 1;
  const start = Math.ceil(keep / 2);
  const end = Math.floor(keep / 2);
  return `${text.slice(0, start)}…${text.slice(text.length - end)}`;
}

function formatTimestamp(iso) {
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
