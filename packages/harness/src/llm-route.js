import {
  HARNESS_DEFAULT_MODEL,
  HARNESS_ELUCID_DEFAULT_BASE_URL,
  HARNESS_ELUCID_DEFAULT_MODEL,
  HARNESS_ELUCID_PROVIDER,
  HARNESS_PROVIDER,
} from './constants.js';

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function modelIdForProfile(defaultModel, researchModel, researchProfile) {
  const fallback = text(defaultModel);
  if (researchProfile?.modelProfile !== 'research') return fallback;
  return text(researchModel) || fallback;
}

export function resolveHarnessLlmProvider(env = process.env) {
  const id = text(env.AI_CENTER_HARNESS_PROVIDER).toLowerCase();
  if (id === 'elucid' || id === 'elucid-grok' || id === 'grok') return HARNESS_ELUCID_PROVIDER;
  return HARNESS_PROVIDER;
}

// Host-only request selector. Model identifiers come from a configured allowlist;
// credentials remain environment references and never enter page contracts.
export function resolveGoogleArticleModel(env = process.env, requestedModel) {
  const defaultModel=text(env.AI_CENTER_HARNESS_ARTICLE_MODEL) || 'gemini-3.1-flash-lite';
  const allowed=new Set([defaultModel,...String(env.AI_CENTER_GEMINI_ARTICLE_MODELS || '').split(',').map(text).filter(Boolean)]);
  const model=requestedModel===undefined ? defaultModel : text(requestedModel);
  if(!model || !allowed.has(model) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model))throw new Error('Google article model is not configured');
  return model;
}

export function resolveGoogleArticleModelPool(env = process.env) {
  return [...new Set(String(env.AI_CENTER_GEMINI_ARTICLE_MODEL_POOL || '').split(',').map(text).filter(Boolean))]
    .map(model=>resolveGoogleArticleModel(env,model));
}

export function resolveGoogleHourlyModel(env = process.env, requestedModel) {
  return resolveGoogleArticleModel({...env,
    AI_CENTER_HARNESS_ARTICLE_MODEL:text(env.AI_CENTER_HARNESS_HOURLY_MODEL) || 'gemini-3.1-flash-lite',
    AI_CENTER_GEMINI_ARTICLE_MODELS:env.AI_CENTER_GEMINI_HOURLY_MODELS || '',
  },requestedModel);
}

export function resolveGoogleHourlyModelPool(env = process.env) {
  return [...new Set(String(env.AI_CENTER_GEMINI_HOURLY_MODEL_POOL || '').split(',').map(text).filter(Boolean))]
    .map(model=>resolveGoogleHourlyModel(env,model));
}

export function resolveHarnessLlm(env = process.env, { researchProfile, closedTask, googleModel } = {}) {
  const article=closedTask==='article-normalize';
  const articleMaxTokens=Number(env.AI_CENTER_HARNESS_ARTICLE_MAX_TOKENS || 6144);
  if(article && ![4096,6144].includes(articleMaxTokens))throw new Error('article max tokens must be 4096 or 6144');
  const hourly = closedTask === 'hourly-brief';
  const configuredProvider = resolveHarnessLlmProvider(env);
  const google=(article && text(env.AI_CENTER_HARNESS_ARTICLE_PROVIDER)==='google') || (hourly && text(env.AI_CENTER_HARNESS_HOURLY_PROVIDER)==='google');
  const hourlyMaxTokens=Number(env.AI_CENTER_HARNESS_HOURLY_MAX_TOKENS || (google ? 4096 : 8192));
  if(hourly && ![4096,6144,8192].includes(hourlyMaxTokens))throw new Error('hourly max tokens must be 4096, 6144 or 8192');
  if(hourly && text(env.AI_CENTER_HARNESS_HOURLY_PROVIDER) && !['google','elucid-grok'].includes(text(env.AI_CENTER_HARNESS_HOURLY_PROVIDER)))throw new Error('invalid hourly provider');
  if(googleModel!==undefined && !google)throw new Error('Google model selector requires a closed Google task');
  if(article && text(env.AI_CENTER_HARNESS_ARTICLE_PROVIDER) && !['google','elucid-grok'].includes(text(env.AI_CENTER_HARNESS_ARTICLE_PROVIDER)))throw new Error('invalid article provider');
  const provider = google ? 'google' : hourly || article ? HARNESS_ELUCID_PROVIDER : configuredProvider;
  const elucidKeyEnv = text(env.ELUCID_GROK_API_KEY)
    ? 'ELUCID_GROK_API_KEY'
    : (text(env.AI_CENTER_GROK_API_KEY) ? 'AI_CENTER_GROK_API_KEY' : 'ELUCID_GROK_API_KEY');
  const elucidBaseURL = (text(env.AI_CENTER_ELUCID_GROK_API_ROOT) || HARNESS_ELUCID_DEFAULT_BASE_URL)
    .replace(/\/+$/, '');
  const deepseekBaseURL = text(env.DEEPSEEK_BASE_URL).replace(/\/+$/, '');
  const elucidDefaultModel = ((hourly || article) ? (text(env.AI_CENTER_HARNESS_HOURLY_PROVIDER)!=='google' ? text(env.AI_CENTER_HARNESS_HOURLY_MODEL) : '') || (configuredProvider===HARNESS_ELUCID_PROVIDER ? text(env.AI_CENTER_HARNESS_MODEL) : '') : text(env.AI_CENTER_HARNESS_MODEL)) || HARNESS_ELUCID_DEFAULT_MODEL;
  const deepseekDefaultModel = text(env.AI_CENTER_HARNESS_MODEL) || HARNESS_DEFAULT_MODEL;
  const researchModel = text(env.AI_CENTER_HARNESS_RESEARCH_MODEL);
  const defaultModel = provider === HARNESS_ELUCID_PROVIDER ? elucidDefaultModel : deepseekDefaultModel;
  const model = google ? (hourly ? resolveGoogleHourlyModel(env,googleModel) : resolveGoogleArticleModel(env,googleModel)) : article ? text(env.AI_CENTER_HARNESS_ARTICLE_MODEL) || elucidDefaultModel : hourly ? defaultModel : modelIdForProfile(defaultModel, researchModel, researchProfile);
  const googleKeyEnv=text(env[hourly ? 'AI_CENTER_HARNESS_HOURLY_KEY_ENV' : 'AI_CENTER_HARNESS_ARTICLE_KEY_ENV']) || String(env.AI_CENTER_GEMINI_KEY_ENVS || 'GEMINI_API_KEY,GEMINI_API_KEY2,GEMINI_API_KEY3,GEMINI_API_KEY4,GEMINI_API_KEY5').split(',').map(k=>k.trim()).find(k=>text(env[k])) || 'GEMINI_API_KEY';
  const apiKeyEnv = google ? googleKeyEnv : provider === HARNESS_ELUCID_PROVIDER ? elucidKeyEnv : 'DEEPSEEK_API_KEY';
  return {
    provider,
    model,
    ...(hourly ? {execution:{version:'hourly-execution-v1',fallback:'none',maxTokens:hourlyMaxTokens,reasoning:google ? 'off' : 'low',retryPolicy:'none',...(google ? {wireThinking:'MINIMAL',modelPool:resolveGoogleHourlyModelPool(env)} : {})}} : {}),
    ...(article ? {execution:{version:'article-execution-v2',fallback:env.AI_CENTER_HARNESS_ARTICLE_FALLBACK || 'none',fallbackModel:env.AI_CENTER_HARNESS_ARTICLE_FALLBACK_MODEL || 'grok-4.7',maxTokens:articleMaxTokens,reasoning:google ? 'off' : 'low',...(google ? {wireThinking:'MINIMAL',...(resolveGoogleArticleModelPool(env).length ? {modelPool:resolveGoogleArticleModelPool(env)} : {})} : {}),retryPolicy:'none'}} : {}),
    defaultModel,
    researchModel,
    apiKeyEnv,
    apiKey: text(env[apiKeyEnv]),
    baseURL: google ? 'https://generativelanguage.googleapis.com/v1beta' : provider === HARNESS_ELUCID_PROVIDER ? elucidBaseURL : deepseekBaseURL,
    protocol: google ? 'google-generative-ai' : provider === HARNESS_ELUCID_PROVIDER ? 'openai-responses' : '',
    settingsYaml: materializeHarnessSettings({
      google:google ? {keyEnv:googleKeyEnv,model,maxTokens:hourly ? hourlyMaxTokens : articleMaxTokens} : null,
      briefModel: ['media-brief','daily-analysis','hourly-brief','article-normalize'].includes(closedTask) && provider === HARNESS_ELUCID_PROVIDER ? model : '',
      briefMaxTokens:article ? articleMaxTokens : hourly ? hourlyMaxTokens : 4096,
      noRetries:article,
      elucidKeyEnv,
      elucidBaseURL,
      deepseekBaseURL,
      models: [...new Set([
        elucidDefaultModel,
        deepseekDefaultModel,
        researchModel,
        model,
      ].filter(Boolean))],
    }),
  };
}

export function missingHarnessLlmCredential(env = process.env, llm = resolveHarnessLlm(env)) {
  return !text(llm?.apiKey);
}

export function harnessLlmCredentialError(llm) {
  if(llm?.provider==='google')return `Harness Google task 需要 ${llm.apiKeyEnv}`;
  if (llm?.provider === HARNESS_ELUCID_PROVIDER) {
    return `Harness runtime 需要 ${llm.apiKeyEnv || 'ELUCID_GROK_API_KEY'}`;
  }
  return 'Harness runtime 需要 DEEPSEEK_API_KEY';
}

export function materializeHarnessSettings({
  elucidKeyEnv,
  elucidBaseURL,
  deepseekBaseURL,
  models = [HARNESS_ELUCID_DEFAULT_MODEL, HARNESS_DEFAULT_MODEL],
  briefModel = '',
  briefMaxTokens = 4096,
  noRetries=false,
  google=null,
} = {}) {
  const ids = [...new Set((models.length ? models : [HARNESS_ELUCID_DEFAULT_MODEL]).map((id) => text(id)).filter(Boolean))];
  const modelLines = ids.map((id) => `        - id: ${yamlString(id)}${id === briefModel ? `\n          maxTokens: ${briefMaxTokens}\n          reasoningEfforts:\n            low: low` : ''}`).join('\n');
  const deepseek = [
    'llm-deepseek:',
    `  apiKeyEnv: ${yamlString('DEEPSEEK_API_KEY')}`,
  ];
  if (text(deepseekBaseURL)) deepseek.push(`  baseURL: ${yamlString(deepseekBaseURL)}`);
  return [
    '# Generated by AI Center. Credential values stay in the environment, not this file.',
    ...deepseek,
    'llm-pi-ai:',
    '  providers:',
    `    ${HARNESS_ELUCID_PROVIDER}:`,
    `      apiKeyEnv: ${yamlString(elucidKeyEnv || 'ELUCID_GROK_API_KEY')}`,
    '      api: openai-responses',
    ...(noRetries ? ['      retryPolicy:', '        mode: normal', '        maxRetries: 0'] : []),
    `      baseURL: ${yamlString(elucidBaseURL || HARNESS_ELUCID_DEFAULT_BASE_URL)}`,
    '      displayName: Elucid Grok',
    ...(briefModel ? ['      reasoning: low'] : []),
    '      models:',
    modelLines,
    ...(google ? [
      '    google:',
      `      apiKeyEnv: ${yamlString(google.keyEnv)}`,
      // Omit api: reuse the installed builtin Google native protocol.
      '      reasoning: off',
      '      retryPolicy:',
      '        mode: normal',
      '        maxRetries: 0',
      '      models:',
      `        - id: ${yamlString(google.model)}`,
      `          maxTokens: ${google.maxTokens}`,
      '          reasoningEfforts:',
      '            off: off',
      '            low: low',
    ] : []),
    '',
  ].join('\n');
}

export function materializeElucidSettings(options = {}) {
  return materializeHarnessSettings(options);
}
