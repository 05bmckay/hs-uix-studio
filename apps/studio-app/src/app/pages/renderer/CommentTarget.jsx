import React from "react";
import { Box, Button, Flex, Icon } from "@hubspot/ui-extensions";
import { CommentModal } from "./CommentModal.jsx";

// `color` distinguishes leaf vs group targets at a glance: leaf comments use
// the default ("inherit", dark) while named-group comments use "success"
// (green) so a reviewer can tell which scope they're commenting on.
const dotButton = (nodeId, nodeSummary, onAddComment, color) => (
  <Button
    variant="transparent"
    size="extra-small"
    overlay={
      <CommentModal
        modalId={`comment-modal-${nodeId}`}
        nodeId={nodeId}
        nodeSummary={nodeSummary}
        onSave={onAddComment}
      />
    }
  >
    <Icon name="circleHollow" color={color} screenReaderText="Add comment" />
  </Button>
);

// Block wrapper. Content fills the row, dot sits on the right, top-aligned so
// it stays anchored when the wrapped node is tall (e.g. a Statistics block).
// Used when the parent is a column-like container.
export const CommentTarget = ({
  nodeId,
  nodeSummary,
  onAddComment,
  dotColor = "inherit",
  children,
}) => {
  return (
    <Flex direction="row" align="start" gap="xs">
      <Box flex={1}>{children}</Box>
      {dotButton(nodeId, nodeSummary, onAddComment, dotColor)}
    </Flex>
  );
};

// Inline wrapper for row-context children (Flex row, Inline, ButtonRow,
// TableRow). Content does NOT stretch — the dot sits immediately to the right
// of the wrapped node so a header/cell label and its tick stay visually
// grouped instead of being pushed to opposite edges of a shared row slot.
export const InlineCommentTarget = ({
  nodeId,
  nodeSummary,
  onAddComment,
  dotColor = "inherit",
  children,
}) => {
  return (
    <Flex direction="row" align="center" gap="xs">
      {children}
      {dotButton(nodeId, nodeSummary, onAddComment, dotColor)}
    </Flex>
  );
};
