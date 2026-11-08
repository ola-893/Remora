export const NEAR_AI_BASE_URL = 'https://cloud-api.near.ai/v1';
export const NEAR_AI_CATALOG_URL = `${NEAR_AI_BASE_URL}/model/list`;

export function inferenceConfig(input) {
  if (!input || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256) throw new Error('Provide --model.');
  const provider = input.provider ?? 'openai-compatible';
  if (!['openai-compatible', 'near-ai'].includes(provider)) throw new Error('Choose --provider near-ai or openai-compatible.');
  const url = new URL(input.baseUrl ?? (provider === 'near-ai' ? NEAR_AI_BASE_URL : undefined));
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Inference URL must use HTTPS or loopback without embedded credentials.');
  const baseUrl = url.href.replace(/\/$/, '');
  if (provider === 'near-ai' && baseUrl !== NEAR_AI_BASE_URL) throw new Error('The near-ai provider uses https://cloud-api.near.ai/v1. Use openai-compatible for a custom endpoint.');
  const apiKeyEnv = input.apiKeyEnv ?? (provider === 'near-ai' ? 'NEAR_AI_API_KEY' : undefined);
  if (apiKeyEnv !== undefined && !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) throw new Error('Provide an environment variable NAME via --api-key-env, never the key itself.');
  const maxSteps = input.maxSteps ?? 12;
  const timeoutSeconds = input.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 600) throw new Error('timeoutSeconds must be between 10 and 600.');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('maxSteps must be between 1 and 100.');
  if (input.thinking !== undefined && typeof input.thinking !== 'boolean') throw new Error('thinking must be true or false.');
  if (provider === 'near-ai' && input.thinking !== undefined && /^openai\/gpt-oss-/i.test(input.model)) throw new Error('GPT-OSS reasoning is always on; omit --thinking and use --reasoning-effort.');
  if (input.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(input.reasoningEffort)) throw new Error('reasoningEffort must be low, medium or high.');
  const maxOutputTokens = input.maxOutputTokens ?? (provider === 'near-ai' ? 2048 : undefined);
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 131072)) throw new Error('maxOutputTokens must be between 1 and 131072.');
  return { provider, protocol: 'openai-chat', baseUrl, model: input.model, ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}), timeoutSeconds, maxSteps };
}

export function completionBody(config, messages, tools) {
  const thinking = config.thinking === undefined ? {} : config.provider === 'near-ai'
    ? { chat_template_kwargs: { [/^moonshotai\/kimi-/i.test(config.model) ? 'thinking' : 'enable_thinking']: config.thinking } }
    : { enable_thinking: config.thinking };
  return { model: config.model, messages, tools, tool_choice: 'auto', stream: false, ...thinking,
    ...(config.reasoningEffort !== undefined ? { reasoning_effort: config.reasoningEffort } : {}),
    ...(config.maxOutputTokens !== undefined ? { max_tokens: config.maxOutputTokens } : {}) };
}

export async function listInferenceModels({ provider = 'near-ai', fetchImpl = fetch } = {}) {
  if (provider !== 'near-ai') throw new Error('Model discovery currently supports --provider near-ai.');
  const models = [], seen = new Set();
  let offset = 0, total;
  do {
    const url = new URL(NEAR_AI_CATALOG_URL);
    if (offset) { url.searchParams.set('offset', String(offset)); url.searchParams.set('limit', '100'); }
    // The public catalog does not need a key. Never forward a configured model key here.
    const response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`NEAR_AI_CATALOG_HTTP_${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page.models) || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > 10000 || page.offset !== offset || (total !== undefined && page.total !== total)) throw new Error('INVALID_NEAR_AI_CATALOG');
    total = page.total;
    if ((!page.models.length && offset < total) || offset + page.models.length > total) throw new Error('INVALID_NEAR_AI_CATALOG');
    for (const entry of page.models) {
      if (typeof entry.modelId !== 'string' || !entry.modelId || seen.has(entry.modelId)) throw new Error('INVALID_NEAR_AI_CATALOG');
      seen.add(entry.modelId);
      const m = entry.metadata ?? {};
      const features = Array.isArray(m.supportedFeatures) ? m.supportedFeatures.filter(s => typeof s === 'string') : [];
      const textOutput = m.architecture?.outputModalities?.includes('text') === true;
      models.push({ id: entry.modelId, name: m.modelDisplayName ?? entry.modelId,
        agentCompatible: features.includes('tools') && textOutput, supportedFeatures: features,
        providerReportedVerifiable: m.verifiable === true, attestationSupported: m.attestationSupported === true,
        providerType: typeof m.providerType === 'string' ? m.providerType : null,
        maxOutputTokens: Number.isSafeInteger(m.maxOutputLength) ? m.maxOutputLength : null });
    }
    offset += page.models.length;
  } while (offset < total);
  return { provider: 'near-ai', baseUrl: NEAR_AI_BASE_URL, catalogUrl: NEAR_AI_CATALOG_URL,
    fetchedAt: new Date().toISOString(), total, models, metadataSource: 'provider public catalog',
    attestationVerified: false, policySignerLocation: 'local host' };
}
