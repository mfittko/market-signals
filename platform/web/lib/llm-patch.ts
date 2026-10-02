// The patch the Chat and model card saves. A cleared model or token limit is sent as null, which removes the stored value.
export function llmPatch(i: {
  provider: string; model: string; tokens: string; base: string; needsBase: boolean; key: string; akey: string;
  models: Record<string, string>;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = { provider: i.provider };
  const model = i.model.trim();
  if (model || i.models[i.provider]) patch.models = { ...i.models, [i.provider]: model || null };
  // the official provider must not keep a stored base URL: the engine reads openai plus a base URL as openai-compatible
  if (i.needsBase) patch.OPENAI_BASE_URL = i.base.trim();
  else if (i.provider === 'openai') patch.OPENAI_BASE_URL = '';
  if (i.key.trim()) patch.OPENAI_API_KEY = i.key.trim();
  if (i.akey.trim()) patch.ANTHROPIC_API_KEY = i.akey.trim();
  patch.maxCompletionTokens = i.tokens.trim() ? Number(i.tokens) : null;
  return patch;
}
