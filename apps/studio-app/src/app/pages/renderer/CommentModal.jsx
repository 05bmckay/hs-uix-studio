import React, { useState } from "react";
import {
  Button,
  Dropdown,
  Flex,
  Modal,
  ModalBody,
  ModalFooter,
  Tag,
  TextArea,
  useExtensionApi,
} from "@hubspot/ui-extensions";

// Modal used by CommentTarget to capture a comment on a node. Opens from
// the overlay prop on a Button.
export const CommentModal = ({ modalId, nodeId, nodeSummary, onSave }) => {
  const { actions } = useExtensionApi();
  const [text, setText] = useState("");

  const handleSave = ({ sendNow = false } = {}) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSave(nodeId, nodeSummary, trimmed, { sendNow });
    setText("");
    actions.closeOverlay(modalId);
  };

  const handleCancel = () => {
    setText("");
    actions.closeOverlay(modalId);
  };

  return (
    <Modal id={modalId} title="Add comment" width="md">
      <ModalBody>
        <Flex direction="column" gap="sm">
          {nodeSummary && <Tag variant="default">{nodeSummary}</Tag>}
          <TextArea
            label="Comment"
            name="comment-text"
            placeholder="What should change about this?"
            value={text}
            onInput={setText}
            rows={4}
          />
        </Flex>
      </ModalBody>
      <ModalFooter>
        <Flex direction="column">
          <Flex direction="row" justify="between">
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
            <Dropdown
              variant="primary"
              buttonText="Comment"
              disabled={!text.trim()}
            >
              <Dropdown.ButtonItem onClick={() => handleSave()}>
                Comment
              </Dropdown.ButtonItem>
              <Dropdown.ButtonItem onClick={() => handleSave({ sendNow: true })}>
                Send now
              </Dropdown.ButtonItem>
            </Dropdown>
          </Flex>
        </Flex>
      </ModalFooter>
    </Modal>
  );
};
