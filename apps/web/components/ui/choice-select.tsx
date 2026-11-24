"use client";
/**
 * COMPONENT: ChoiceSelect
 * PURPOSE: Keyboard-accessible selector supporting both static menus and inline-searchable dropdown lists.
 * INPUTS: Selected value, option list, change handler, optional search flags, description row layout, and footer node.
 * OUTPUTS: Accessible trigger button + portal menu via Base UI Select or searchable Popover listbox.
 * STEPS:
 *   1. When `searchable` is omitted/false, preserve native Base UI Select semantics and list rendering.
 *   2. When `searchable` is true, render a Base UI Popover anchored to the trigger button (`type="button"`).
 *   3. On open, reset the search query, highlight the current enabled selection, and focus the search input cleanly.
 *   4. Filter options token-by-token via `filterChoiceOptions`, support ArrowUp/ArrowDown/Enter/Escape navigation, and select on Enter or click.
 * EDGE CASES:
 *   - Empty search match: displays `emptySearchText` without crashing keyboard navigation.
 *   - Disabled options (e.g. planned frameworks): skipped during arrow navigation and unselectable on Enter/click.
 *   - Rendered inside a `<form>` (Settings provider connection cards): `type="button"` and `preventDefault()` on Enter prevent accidental form submission.
 * ERROR STATES:
 *   - All options filtered or disabled → Enter is a safe no-op.
 */

import { Popover } from "@base-ui/react/popover";
import { Select } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useRef, useState } from "react";
import {
  filterChoiceOptions,
  type ChoiceOption,
} from "./choice-select-filter";

export type { ChoiceOption };

function findFirstEnabledIndex(options: readonly ChoiceOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

function findNextEnabledIndex(
  options: readonly ChoiceOption[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1;
  const start = currentIndex >= 0 && currentIndex < options.length ? currentIndex : 0;
  for (let offset = 1; offset <= options.length; offset++) {
    const candidate =
      (start + direction * offset + options.length) % options.length;
    if (!options[candidate]?.disabled) return candidate;
  }
  return -1;
}

interface SearchableChoiceSelectProps {
  label: string;
  popupClassName?: string;
  description?: string;
  value: string | null;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  selectedText: string;
  footer?: React.ReactNode;
  searchPlaceholder?: string;
  emptySearchText?: string;
}

function SearchableChoiceSelect({
  label,
  popupClassName,
  description,
  value,
  options,
  onChange,
  disabled,
  selectedText,
  footer,
  searchPlaceholder,
  emptySearchText,
}: SearchableChoiceSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filteredOptions = filterChoiceOptions(options, query);
  const activeIndex =
    highlightedIndex >= 0 &&
    highlightedIndex < filteredOptions.length &&
    !filteredOptions[highlightedIndex]?.disabled
      ? highlightedIndex
      : findFirstEnabledIndex(filteredOptions);

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    setQuery("");
    if (nextOpen) {
      const selectedIndex = options.findIndex(
        (option) => option.value === value && !option.disabled,
      );
      setHighlightedIndex(
        selectedIndex >= 0 ? selectedIndex : findFirstEnabledIndex(options),
      );
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  };

  const selectOption = (option: ChoiceOption): void => {
    if (option.disabled) return;
    onChange(option.value);
    handleOpenChange(false);
  };

  const handleSearchKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = findNextEnabledIndex(filteredOptions, activeIndex, 1);
      if (next >= 0) {
        setHighlightedIndex(next);
        optionRefs.current[next]?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const previous = findNextEnabledIndex(filteredOptions, activeIndex, -1);
      if (previous >= 0) {
        setHighlightedIndex(previous);
        optionRefs.current[previous]?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen =
        activeIndex >= 0 ? filteredOptions[activeIndex] : undefined;
      if (chosen && !chosen.disabled) selectOption(chosen);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handleOpenChange(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className={`choice-trigger${description ? " choice-settings-row" : ""}`}
      >
        {description && (
          <span className="choice-settings-label">
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
        )}
        <span title={selectedText}>{selectedText}</span>
        <span>
          <ChevronDownIcon size={13} aria-hidden="true" />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} className="choice-positioner">
          <Popover.Popup
            className={`choice-popup choice-popup-searchable ${popupClassName ?? ""}`}
          >
            <div className="choice-search-wrap">
              <SearchIcon size={14} aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                maxLength={200}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setQuery(nextQuery);
                  setHighlightedIndex(
                    findFirstEnabledIndex(
                      filterChoiceOptions(options, nextQuery),
                    ),
                  );
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder={
                  searchPlaceholder ?? `Search ${label.toLocaleLowerCase()}…`
                }
                aria-label={`Search ${label.toLocaleLowerCase()}`}
                className="choice-search-input"
              />
            </div>
            <div className="choice-list" role="listbox" aria-label={label}>
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option, index) => {
                  const isSelected = option.value === value;
                  const isHighlighted = index === activeIndex && !option.disabled;
                  return (
                    <button
                      key={option.value}
                      ref={(node) => {
                        optionRefs.current[index] = node;
                      }}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={option.disabled}
                      data-highlighted={isHighlighted ? "" : undefined}
                      data-disabled={option.disabled ? "" : undefined}
                      className="choice-option"
                      onMouseEnter={() => {
                        if (!option.disabled) setHighlightedIndex(index);
                      }}
                      onClick={() => selectOption(option)}
                    >
                      <span>
                        <span>{option.label}</span>
                        {option.description && (
                          <span className="choice-description">
                            {option.description}
                          </span>
                        )}
                      </span>
                      {isSelected && (
                        <CheckIcon size={15} aria-hidden="true" />
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="choice-empty">
                  {emptySearchText ?? "No matching options found."}
                </div>
              )}
            </div>
            {footer && <div className="choice-footer">{footer}</div>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
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
  popupClassName,
  searchable = false,
  searchPlaceholder,
  emptySearchText,
}: {
  label: string;
  popupClassName?: string;
  description?: string;
  value: string | null;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  displayValue?: string;
  footer?: React.ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptySearchText?: string;
}): React.JSX.Element {
  const selectedText =
    displayValue ??
    options.find((option) => option.value === value)?.label ??
    "Choose…";

  if (searchable) {
    return (
      <SearchableChoiceSelect
        label={label}
        popupClassName={popupClassName}
        description={description}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        selectedText={selectedText}
        footer={footer}
        searchPlaceholder={searchPlaceholder}
        emptySearchText={emptySearchText}
      />
    );
  }

  return (
    <Select.Root
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      disabled={disabled}
    >
      <Select.Trigger
        aria-label={label}
        className={`choice-trigger${description ? " choice-settings-row" : ""}`}
      >
        {description && (
          <span className="choice-settings-label">
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
        )}
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
          <Select.Popup className={`choice-popup ${popupClassName ?? ""}`}>
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
