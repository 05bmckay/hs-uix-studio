import React from "react";
import {
  Button,
  Flex,
  Heading,
  Input,
  MultiSelect,
  Select,
  Text,
  TextArea,
} from "@hubspot/ui-extensions";

// Takes over the right pane (replaces Preview) when Studio has clarifying
// questions. User answers, hits Submit, answers get folded into the chat
// thread as a user message, and the pane flips back to Preview.
export const QuestionsPanel = ({
  questions = [],
  answers = {},
  onAnswerChange,
  onSubmit,
  onSkip,
}) => {
  const requiredSatisfied = questions.every(
    (q) => !q.required || hasAnswer(answers[q.id]),
  );

  return (
    <Flex direction="column" gap="md">
      <Flex direction="row" justify="between" align="end">
        <Heading>A few questions</Heading>
        <Text variant="microcopy">
          {questions.length} {questions.length === 1 ? "question" : "questions"}
        </Text>
      </Flex>
      <Text variant="microcopy">
        Answers sharpen the first pass. You can always steer in chat after.
      </Text>
      <Flex direction="column" gap="sm">
        {questions.map((q, i) => (
          <QuestionField
            key={q.id}
            index={i}
            question={q}
            value={answers[q.id]}
            onChange={(val) => onAnswerChange(q.id, val)}
          />
        ))}
      </Flex>
      <Flex direction="row" justify="end" gap="sm">
        {onSkip && (
          <Button variant="secondary" onClick={onSkip}>
            Skip
          </Button>
        )}
        <Button
          variant="primary"
          onClick={onSubmit}
          disabled={!requiredSatisfied}
        >
          Submit answers
        </Button>
      </Flex>
    </Flex>
  );
};

const QuestionField = ({ index, question, value, onChange }) => {
  const label = `${index + 1}. ${question.prompt}`;
  const name = question.id;

  switch (question.type) {
    case "short-text":
      return (
        <Input
          label={label}
          name={name}
          value={value ?? ""}
          onInput={onChange}
          placeholder={question.placeholder}
        />
      );
    case "single-select":
      return (
        <Select
          label={label}
          name={name}
          value={value ?? ""}
          onChange={onChange}
          options={question.options || []}
        />
      );
    case "multi-select":
      return (
        <MultiSelect
          label={label}
          name={name}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          options={question.options || []}
        />
      );
    case "long-text":
    default:
      return (
        <TextArea
          label={label}
          name={name}
          value={value ?? ""}
          onInput={onChange}
          rows={3}
          placeholder={question.placeholder}
        />
      );
  }
};

function hasAnswer(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim().length > 0;
}

function formatAnswerValue(q, v) {
  if (Array.isArray(v)) {
    // Prefer human labels from options; fall back to the value.
    const labels = v.map((val) => {
      const opt = (q.options || []).find((o) => o.value === val);
      return opt?.label ?? val;
    });
    return labels.join(", ");
  }
  return String(v).trim();
}

// Formats answers as a markdown-ish block suitable to append to the chat
// thread as a user message. Kept readable so it looks natural alongside
// free-text messages.
export function formatAnswersAsMessage(questions, answers) {
  const lines = questions
    .map((q) => {
      const v = answers[q.id];
      if (!hasAnswer(v)) return null;
      return `**${q.prompt}**\n${formatAnswerValue(q, v)}`;
    })
    .filter(Boolean);
  return lines.join("\n\n");
}
