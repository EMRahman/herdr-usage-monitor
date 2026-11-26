export const PROMPT_PROVIDERS = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

/** @param {string} provider */
export function supportsPromptPreviews(provider) {
  return Object.hasOwn(PROMPT_PROVIDERS, provider);
}

/** @param {string} name */
const words = (name) => name.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Limit labels sometimes name a model or family instead of the whole provider.
 * @param {string} provider
 * @param {string} [group]
 * @param {string} [bucket]
 * @returns {((model: string) => boolean) | null}
 */
export function quotaModelFilter(provider, group, bucket) {
  if (provider === "claude" && typeof bucket === "string") {
    const family = words(bucket).find((word) => word === "opus" || word === "sonnet");
    if (family) return (model) => words(model).includes(family);
  }
  if (provider !== "antigravity" || !group) return null;

  const groupWords = words(group);
  if (groupWords[0] === "gemini" && /^\d/.test(groupWords[1] ?? "")) {
    // A quota can cover a single Gemini model, including variants with a suffix in the log.
    const modelName = `-${groupWords.join("-")}-`;
    return (model) => `-${words(model).join("-")}-`.includes(modelName);
  }
  const families = groupWords.filter((word) => word === "gemini" || word === "claude" || word === "gpt");
  if (!families.length) return null;
  return (model) => {
    const modelWords = words(model);
    return families.some((family) => modelWords.includes(family));
  };
}
