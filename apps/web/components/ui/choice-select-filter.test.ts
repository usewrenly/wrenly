import { describe, expect, test } from "bun:test";
import {
  filterChoiceOptions,
  type ChoiceOption,
} from "./choice-select-filter";

const GEMMA: ChoiceOption = {
  value: '["ollama","gemma4:12b"]',
  label: "Gemma 4 12B",
  description: "Local Ollama",
};
const CLAUDE: ChoiceOption = {
  value: '["anthropic","claude-sonnet-4-6"]',
  label: "Claude Sonnet 4.6",
  description: "Anthropic",
};
const NEXTJS: ChoiceOption = {
  value: "nextjs",
  label: "Next.js",
};
const VUE: ChoiceOption = {
  value: "vue",
  label: "Vue.js",
  description: "Coming soon",
  disabled: true,
};
const SAMPLE_OPTIONS: ChoiceOption[] = [GEMMA, CLAUDE, NEXTJS, VUE];

describe("filterChoiceOptions", () => {
  test("returns all options in original order when query is empty or whitespace", () => {
    expect(filterChoiceOptions(SAMPLE_OPTIONS, "")).toEqual(SAMPLE_OPTIONS);
    expect(filterChoiceOptions(SAMPLE_OPTIONS, "   ")).toEqual(SAMPLE_OPTIONS);
  });

  test("matches by label, description, or underlying option value case-insensitively", () => {
    expect(filterChoiceOptions(SAMPLE_OPTIONS, "NEXT.JS")).toEqual([NEXTJS]);
    expect(filterChoiceOptions(SAMPLE_OPTIONS, "anthropic")).toEqual([CLAUDE]);
    expect(filterChoiceOptions(SAMPLE_OPTIONS, "claude-sonnet-4-6")).toEqual([
      CLAUDE,
    ]);
  });

  test("matches multi-word queries across label and description tokens", () => {
    expect(filterChoiceOptions(SAMPLE_OPTIONS, "ollama gemma")).toEqual([GEMMA]);
    expect(filterChoiceOptions(SAMPLE_OPTIONS, "coming vue")).toEqual([VUE]);
  });

  test("returns an empty array when no options match", () => {
    expect(filterChoiceOptions(SAMPLE_OPTIONS, "nonexistent-provider")).toEqual(
      [],
    );
  });
});
