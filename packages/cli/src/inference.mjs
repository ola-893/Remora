export const NEAR_AI_BASE_URL = 'https://cloud-api.near.ai/v1';
export const NEAR_AI_CATALOG_URL = `${NEAR_AI_BASE_URL}/model/list`;
export const INFERENCE_KEY_SETUP = 'Run agentstream inference set with --api-key to enter the inference API key.';

export function validateInferenceKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > 8192 || /[^\x21-\x7E]/.test(key)) throw new Error('INFERENCE_CREDENTIAL_INVALID');
  return key;
}

export async function assertInferenceModel(config, fetchImpl = fetch) {
  if (/^(MODEL_ID|YOUR_MODEL)$/.test(config.model)) throw new Error('UNKNOWN_INFERENCE_MODEL: choose a model id from the provider catalog. Run agentstreams inference models for near-ai.');
  if (config.provider !== 'near-ai') return config;
  const catalog = await listInferenceModels({ provider: 'near-ai', fetchImpl });
  const found = catalog.models.find(model => model.id === config.model);
  if (!found) throw new Error(`UNKNOWN_INFERENCE_MODEL: ${config.model} is not in the NEAR AI catalog.`);
  if (!found.agentCompatible) throw new Error(`INFERENCE_MODEL_TOOLS_REQUIRED: ${config.model} does not advertise tool calls.`);
  if (!found.confidentialEligible) throw new Error(`INFERENCE_MODEL_ATTESTATION_REQUIRED: choose a verifiable model from inference models.`);
  return config;
}

export function inferenceConfig(input) {
  if (!input || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256) throw new Error('Provide --model.');
  // Older loopback profiles used the wire protocol as their provider name.
  const provider = input.provider === 'openai-compatible' ? 'local' : input.provider ?? 'local';
  if (!['local', 'near-ai'].includes(provider)) throw new Error('INFERENCE_PROVIDER_UNSUPPORTED: choose --provider local or near-ai.');
  let url;
  try { url = new URL(input.baseUrl ?? (provider === 'near-ai' ? NEAR_AI_BASE_URL : 'http://127.0.0.1:11434/v1')); }
  catch { throw new Error('INFERENCE_ENDPOINT_UNSUPPORTED: provide an absolute inference URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('INFERENCE_ENDPOINT_UNSUPPORTED: inference URLs cannot contain credentials, queries or fragments.');
  const baseUrl = url.href.replace(/\/$/, '');
  if (provider === 'near-ai' && baseUrl !== NEAR_AI_BASE_URL) throw new Error('INFERENCE_ENDPOINT_UNSUPPORTED: the near-ai provider uses https://cloud-api.near.ai/v1.');
  if (provider === 'local' && (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('INFERENCE_ENDPOINT_UNSUPPORTED: local inference requires a loopback URL. Run inference set --provider local or near-ai.');
  }
  if (input.apiKeyEnv !== undefined) throw new Error(INFERENCE_KEY_SETUP);
  const apiKeyStored = input.apiKeyStored === true;
  const maxSteps = input.maxSteps ?? 12;
  const timeoutSeconds = input.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 600) throw new Error('timeoutSeconds must be between 10 and 600.');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('maxSteps must be between 1 and 100.');
  if (input.thinking !== undefined && typeof input.thinking !== 'boolean') throw new Error('thinking must be true or false.');
  if (provider === 'near-ai' && input.thinking !== undefined && /^openai\/gpt-oss-/i.test(input.model)) throw new Error('GPT-OSS reasoning is always on; omit --thinking and use --reasoning-effort.');
  if (input.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(input.reasoningEffort)) throw new Error('reasoningEffort must be low, medium or high.');
  const maxOutputTokens = input.maxOutputTokens ?? (provider === 'near-ai' ? 2048 : undefined);
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 131072)) throw new Error('maxOutputTokens must be between 1 and 131072.');
  return { provider, protocol: 'openai-chat', baseUrl, model: input.model, ...(apiKeyStored ? { apiKeyStored } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}), timeoutSeconds, maxSteps };
}

export function completionBody(config, messages, tools, responseFormat) {
  const thinking = config.thinking === undefined ? {} : config.provider === 'near-ai'
    ? { chat_template_kwargs: { [/^moonshotai\/kimi-/i.test(config.model) ? 'thinking' : 'enable_thinking']: config.thinking } }
    : { enable_thinking: config.thinking };
  return { model: config.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: false, ...thinking,
    ...(responseFormat ? { response_format: responseFormat } : {}),
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
      const agentCompatible = features.includes('tools') && textOutput;
      models.push({ id: entry.modelId, name: m.modelDisplayName ?? entry.modelId,
        agentCompatible, supportedFeatures: features,
        confidentialEligible: agentCompatible && m.verifiable === true && m.attestationSupported === true && m.providerType !== 'external',
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
