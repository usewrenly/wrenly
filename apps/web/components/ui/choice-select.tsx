"use client";
// Shares keyboard-accessible selection controls between full-width and compact composers.
import { Select } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}
/** Keeps selection semantics and focus management in the installed Base UI primitive. */
export function ChoiceSelect({
  label,
  value,
  options,
  onChange,
  disabled,
  displayValue,
  footer,
  description,
}: {
  label: string;
  description?: string;
  value: string | null;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  displayValue?: string;
  footer?: React.ReactNode;
}): React.JSX.Element {
  const selectedText =
    displayValue ??
    options.find((option) => option.value === value)?.label ??
    "Choose…";
  return (
    <Select.Root
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      disabled={disabled}
    >
      <Select.Trigger aria-label={label} className={`choice-trigger${description ? " choice-settings-row" : ""}`}>
        {description && <span className="choice-settings-label"><strong>{label}</strong><small>{description}</small></span>}
        <span title={selectedText}>{selectedText}</span>
        <Select.Icon>
          <ChevronDownIcon size={13} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          sideOffset={6}
          className="choice-positioner"
          alignItemWithTrigger={false}
        >
          <Select.Popup className="choice-popup">
            <Select.List>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="choice-option"
                >
                  <span>
                    <Select.ItemText>{option.label}</Select.ItemText>
                    {option.description && (
                      <span className="choice-description">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <Select.ItemIndicator>
                    <CheckIcon size={15} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
            {footer && <div className="choice-footer">{footer}</div>}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
