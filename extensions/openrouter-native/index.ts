import { createHash } from "node:crypto";
import type {
  AuthStatus,
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";

const BASE_URL = "https://openrouter.ai/api/v1";
const MODELS_URL = `${BASE_URL}/models`;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30 * 60_000;

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown } | null;
  pricing?: Record<string, unknown> | null;
  context_length?: unknown;
  top_provider?: { max_completion_tokens?: unknown } | null;
  per_request_limits?: { completion_tokens?: unknown } | null;
}

interface CacheEntry {
  key: string;
  fetchedAt: number;
  models: ProviderModelConfig[];
}

interface SyncResult {
  ok: boolean;
  message: string;
  models: ProviderModelConfig[];
}

let cache: CacheEntry | undefined;
let lastGood: CacheEntry | undefined;
let registeredCount = 0;
let lastSync = { ok: false, at: 0, message: "never" };

export default async function openRouterNative(pi: ExtensionAPI) {
  pi.registerCommand("openrouter-sync", {
    description: "Refresh OpenRouter model list",
    handler: async (_args, ctx) => {
      const result = await syncOpenRouter(pi, true, ctx);
      ctx.ui.notify(result.message, result.ok ? "info" : result.models.length ? "warning" : "error");
    },
  });

  pi.registerCommand("openrouter-status", {
    description: "Show OpenRouter model sync status",
    handler: async (_args, ctx) => {
      const auth = ctx.modelRegistry.getProviderAuthStatus("openrouter");
      ctx.ui.notify(statusText(auth), lastSync.ok && !isAuthMissing(auth) ? "info" : "warning");
    },
  });

  await syncOpenRouter(pi, false);
}

async function syncOpenRouter(
  pi: ExtensionAPI,
  force: boolean,
  ctx?: ExtensionCommandContext,
): Promise<SyncResult> {
  const apiKey = await resolveApiKey(ctx);
  const result = await loadModels(force, apiKey);
  if (result.models.length > 0) {
    pi.registerProvider("openrouter", buildProviderConfig(result.models));
    registeredCount = result.models.length;
  }
  lastSync = { ok: result.ok, at: Date.now(), message: result.message };
  return result;
}

async function loadModels(force: boolean, apiKey: string | undefined): Promise<SyncResult> {
  const key = cacheKey(apiKey);
  if (!force && cache?.key === key && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { ok: true, message: `OpenRouter cache fresh: ${cache.models.length} models`, models: cache.models };
  }

  try {
    const models = await fetchOpenRouterModels(apiKey);
    cache = lastGood = { key, fetchedAt: Date.now(), models };
    return { ok: true, message: `OpenRouter synced: ${models.length} models`, models };
  } catch (error) {
    const message = errorMessage(error);
    if (lastGood?.key === key) {
      return {
        ok: false,
        message: `OpenRouter sync failed: ${message}; using last good (${lastGood.models.length} models)`,
        models: lastGood.models,
      };
    }
    return { ok: false, message: `OpenRouter sync failed: ${message}`, models: [] };
  }
}

async function fetchOpenRouterModels(apiKey: string | undefined): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "HTTP-Referer": "https://github.com/adi/pi-openrouter-native",
    "X-OpenRouter-Title": "pi-openrouter-native",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(MODELS_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`/models ${response.status} ${response.statusText}`);

  const payload = (await response.json()) as { data?: unknown };
  const models = (Array.isArray(payload.data) ? payload.data : [])
    .map((model) => toPiModel(model as OpenRouterModel))
    .filter((model): model is ProviderModelConfig => model !== undefined);
  if (models.length === 0) throw new Error("/models returned no usable models");
  return models;
}

export function toPiModel(model: OpenRouterModel): ProviderModelConfig | undefined {
  const id = stringValue(model.id);
  if (!id) return undefined;

  return {
    id,
    name: stringValue(model.name) ?? id,
    reasoning: hasReasoning(model),
    input: hasImageInput(model) ? ["text", "image"] : ["text"],
    cost: {
      input: pricePerMillion(model.pricing?.prompt),
      output: pricePerMillion(model.pricing?.completion),
      cacheRead: pricePerMillion(model.pricing?.input_cache_read ?? model.pricing?.prompt_cache_read),
      cacheWrite: pricePerMillion(model.pricing?.input_cache_write ?? model.pricing?.prompt_cache_write),
    },
    contextWindow: positiveInt(model.context_length) ?? 128_000,
    maxTokens:
      positiveInt(model.top_provider?.max_completion_tokens) ??
      positiveInt(model.per_request_limits?.completion_tokens) ??
      16_384,
  };
}

function buildProviderConfig(models: ProviderModelConfig[]): ProviderConfig {
  return {
    name: "OpenRouter",
    baseUrl: BASE_URL,
    apiKey: "OPENROUTER_API_KEY",
    api: "openai-completions",
    models,
  };
}

async function resolveApiKey(ctx: ExtensionCommandContext | undefined): Promise<string | undefined> {
  const apiKey = ctx ? await ctx.modelRegistry.getApiKeyForProvider("openrouter").catch(() => undefined) : undefined;
  const resolved = apiKey ?? process.env.OPENROUTER_API_KEY;
  return resolved && resolved !== "OPENROUTER_API_KEY" ? resolved : undefined;
}

function cacheKey(apiKey: string | undefined): string {
  return apiKey ? createHash("sha256").update(apiKey).digest("hex") : "no-key";
}

function hasReasoning(model: OpenRouterModel): boolean {
  const params = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
  if (params.some((param) => ["reasoning", "include_reasoning", "reasoning_effort"].includes(String(param)))) {
    return true;
  }
  const text = `${stringValue(model.id) ?? ""} ${stringValue(model.name) ?? ""}`.toLowerCase();
  return /(^|[\s/:_-])(r1|qwq|qwen3|deepresearch|reasoning|thinking)([\s/:_-]|$)/.test(text) || /\b(o1|o3|o4|gpt-5)\b/.test(text);
}

function hasImageInput(model: OpenRouterModel): boolean {
  const modalities = model.architecture?.input_modalities;
  return Array.isArray(modalities) && modalities.includes("image");
}

function pricePerMillion(value: unknown): number {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price * 1_000_000 : 0;
}

function positiveInt(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.name === "TimeoutError"
    ? "fetch timed out after 15s"
    : error instanceof Error
      ? error.message
      : String(error);
}

function statusText(auth: AuthStatus): string {
  return [
    `OpenRouter models: ${registeredCount}`,
    `cache age: ${lastGood ? formatAge(Date.now() - lastGood.fetchedAt) : "none"}`,
    `last sync: ${lastSync.message}${lastSync.at ? ` (${formatAge(Date.now() - lastSync.at)} ago)` : ""}`,
    `auth: ${authStatus(auth)}`,
    ...(isAuthMissing(auth) ? ["warning: picker still lists models; requests need OPENROUTER_API_KEY or /login openrouter"] : []),
  ].join("\n");
}

function authStatus(auth: AuthStatus): string {
  if (isAuthMissing(auth)) return "missing";
  return `${auth.source ?? "configured"}${auth.label ? ` (${auth.label})` : ""}`;
}

function isAuthMissing(auth: AuthStatus): boolean {
  return !auth.configured || (auth.source === "models_json_key" && !process.env.OPENROUTER_API_KEY);
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
