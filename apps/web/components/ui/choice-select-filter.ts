/** Option descriptor shared across static and searchable selector menus. */
export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

/**
 * Filters choice options against a whitespace-tokenized query matching label,
 * secondary description, or underlying value case-insensitively.
 */
export function filterChoiceOptions(
  options: readonly ChoiceOption[],
  query: string,
): ChoiceOption[] {
  const trimmed = query.trim().toLocaleLowerCase();
  if (!trimmed) return [...options];
  const tokens = trimmed.split(/\s+/);
  return options.filter((option) => {
    const haystack =
      `${option.label} ${option.description ?? ""} ${option.value}`.toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
