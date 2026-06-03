import React from "react";
import {
  Flex,
  Panel,
  PanelBody,
  Select,
  Text,
  Toggle,
} from "@hubspot/ui-extensions";

// Runtime controls for the spec's mutable `state` block. Tweaks are intended
// for fast preview switches only: booleans render as toggles and string enums
// render as selects when the spec provides options in data. Freeform text and
// number inputs are intentionally not exposed here — those controls belong in
// the card only when they are part of the actual product UX.
export const TweaksPanel = ({ spec, state, onStateChange }) => {
  const keys = spec?.state ? Object.keys(spec.state) : [];
  const tweakableKeys = keys.filter((key) => isTweakableState(key, spec, state));

  return (
    <Panel id="tweaks-panel" title="Tweak preview" width="sm" variant="modal">
      <PanelBody>

        <Flex direction="column" gap="sm">
          {tweakableKeys.length === 0 ? (
            <Text variant="microcopy">
              This card doesn't expose any tweakable state yet.
            </Text>
          ) : (
            <>
              <Text variant="microcopy">
                Flip states and toggle flags without regenerating the card.
              </Text>
              {tweakableKeys.map((key) => (
                <TweakControl
                  key={key}
                  fieldKey={key}
                  value={state[key]}
                  spec={spec}
                  onStateChange={onStateChange}
                />
              ))}
            </>
          )}
        </Flex>

      </PanelBody>
    </Panel>
  );
};

const TweakControl = ({ fieldKey, value, spec, onStateChange }) => {
  const options = findEnumOptions(fieldKey, spec);
  const label = humanizeKey(fieldKey);

  if (options) {
    return (
      <Select
        label={label}
        name={`tweak-${fieldKey}`}
        options={options}
        value={value ?? ""}
        onChange={(v) => onStateChange(fieldKey, v)}
      />
    );
  }

  if (typeof value === "boolean") {
    return (
      <Toggle
        label={label}
        name={`tweak-${fieldKey}`}
        size="sm"
        checked={value}
        onChange={(v) => onStateChange(fieldKey, v)}
      />
    );
  }

  return null;
};

// Look for a matching `{value,label}[]` array in spec.data so a state
// string maps to a Select with real options. E.g. state.viewMode →
// data.viewModes → [{value: "loaded", label: "Loaded"}, ...].
function findEnumOptions(stateKey, spec) {
  const data = spec?.data;
  if (!data) return null;
  const candidates = [`${stateKey}s`, `${stateKey}Options`, stateKey];
  for (const candidate of candidates) {
    const arr = data[candidate];
    if (
      Array.isArray(arr) &&
      arr.length > 0 &&
      arr[0] &&
      typeof arr[0] === "object" &&
      "value" in arr[0] &&
      "label" in arr[0]
    ) {
      return arr.map((item) => ({ value: item.value, label: item.label }));
    }
  }
  return null;
}

function isTweakableState(key, spec, state) {
  return typeof state?.[key] === "boolean" || Boolean(findEnumOptions(key, spec));
}

function humanizeKey(key) {
  const spaced = key.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
