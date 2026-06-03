import React from "react";
import { Button, Flex, Icon, Link, TextArea } from "@hubspot/ui-extensions";

// Controlled composer used for both Chat and Comments. Parent owns the
// draft value so it persists across tab switches. Optional history toggle
// sits on the left of the send row (chat only); clicking it flips the icon
// to X and signals the parent to show the chat history list in place of the
// current message stream.
export const Composer = ({
  value,
  onChange,
  label,
  name,
  placeholder,
  onSend,
  sendLabel = "Send",
  historyOpen,
  onToggleHistory,
  rows = 4,
  disabled = false,
}) => {
  const handleSend = () => {
    const trimmed = value.trim();
    if (disabled || !trimmed) return;
    onSend(trimmed);
    onChange("");
  };

  return (
    <Flex direction="column" gap="xs">
      <TextArea
        label={label}
        name={name}
        placeholder={placeholder}
        value={value}
        onInput={onChange}
        rows={rows}
      />
      <Flex
        direction="row"
        justify={onToggleHistory ? "between" : "end"}
        align="center"
      >
        {onToggleHistory && (
          <Link onClick={onToggleHistory}>
            <Icon
              name={historyOpen ? "filledXCircleIcon" : "listView"}
              size="sm"
              screenReaderText={
                historyOpen ? "Close history" : "Chat history"
              }
            />
          </Link>
        )}
        <Button
          variant="primary"
          onClick={handleSend}
          disabled={disabled || !value.trim()}
        >
          {sendLabel}
        </Button>
      </Flex>
    </Flex>
  );
};
