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

interface SyncResult {
  ok: boolean;
  message: string;
}

let lastGood: ProviderModelConfig[] | undefined;
let fetchedAt = 0;
let registeredCount = 0;
let lastSync = { ok: false, at: 0, message: "never" };
let inFlight: Promise<SyncResult> | undefined;

export default async function openRouterNative(pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    lastGood = undefined;
    fetchedAt = 0;
    registeredCount = 0;
    lastSync = { ok: false, at: 0, message: "never" };
    inFlight = undefined;
  });

  pi.registerCommand("openrouter-sync", {
    description: "Refresh OpenRouter model list",
    handler: async (_args, ctx) => {
      const result = await syncModels(pi, ctx);
      const models = lastGood?.length ?? 0;
      ctx.ui.notify(result.message, result.ok ? "info" : models > 0 ? "warning" : "error");
    },
  });

  pi.registerCommand("openrouter-status", {
    description: "Show OpenRouter model sync status",
    handler: async (_args, ctx) => {
      const auth = ctx.modelRegistry.getProviderAuthStatus("openrouter");
      ctx.ui.notify(statusText(auth), lastSync.ok && !isAuthMissing(auth) ? "info" : "warning");
    },
  });

  await syncModels(pi);
}

async function syncModels(pi: ExtensionAPI, ctx?: ExtensionCommandContext): Promise<SyncResult> {
  // Dedupe overlapping syncs (e.g. user spams /openrouter-sync) so a slow first
  // request can't stomp module state set by a faster second one.
  if (inFlight) return inFlight;
  inFlight = runSync(pi, ctx).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function runSync(pi: ExtensionAPI, ctx: ExtensionCommandContext | undefined): Promise<SyncResult> {
  const apiKey = await resolveApiKey(ctx);

  try {
    const models = await fetchOpenRouterModels(apiKey);
    lastGood = models;
    fetchedAt = Date.now();
    pi.registerProvider("openrouter", buildProviderConfig(models));
    registeredCount = models.length;
    lastSync = { ok: true, at: Date.now(), message: `OpenRouter synced: ${models.length} models` };
    return lastSync;
  } catch (error) {
    const message = describeFetchError(error);
    if (lastGood && lastGood.length > 0) {
      pi.registerProvider("openrouter", buildProviderConfig(lastGood));
      registeredCount = lastGood.length;
      lastSync = {
        ok: false,
        at: Date.now(),
        message: `OpenRouter sync failed: ${message} — using last good (${lastGood.length} models)`,
      };
    } else {
      // Register empty provider so /openrouter-status still has something to report.
      pi.registerProvider("openrouter", buildProviderConfig([]));
      registeredCount = 0;
      lastSync = {
        ok: false,
        at: Date.now(),
        message: `OpenRouter sync failed: ${message}. No models available — run /openrouter-sync to retry.`,
      };
    }
    return lastSync;
  }
}

async function fetchOpenRouterModels(apiKey: string | undefined): Promise<ProviderModelConfig[]> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "HTTP-Referer": "https://github.com/adstastic/pi-openrouter-native",
    "X-OpenRouter-Title": "pi-openrouter-native",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(MODELS_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw createHttpError(response, apiKey);
  }

  const payload = (await response.json()) as { data?: unknown };
  const models = (Array.isArray(payload.data) ? payload.data : [])
    .map((model) => toPiModel(model as OpenRouterModel))
    .filter((model): model is ProviderModelConfig => model !== undefined);
  if (models.length === 0) throw new Error("/models returned no usable models");
  return models;
}

function createHttpError(response: Response, apiKey: string | undefined): Error {
  const status = response.status;
  const base = `/models returned ${status} ${response.statusText}`;

  if (status === 401) {
    if (!apiKey) {
      return new Error(
        `${base} — no API key found. Set OPENROUTER_API_KEY env var or run /login openrouter. ` +
          `Note: /models is public and works without a key, so a 401 usually means a key was sent but is invalid or misspelled (check env var name).`,
      );
    }
    return new Error(
      `${base} — the API key was rejected. Check that OPENROUTER_API_KEY is correct (typo'd env var name? extra whitespace? key revoked?). ` +
        `Try: unset the key and re-sync to use the public endpoint, or generate a new key at https://openrouter.ai/settings/keys`,
    );
  }

  if (status === 402) {
    return new Error(
      `${base} — OpenRouter account has insufficient credits. Top up at https://openrouter.ai/settings/credits`,
    );
  }

  if (status === 403) {
    return new Error(
      `${base} — access denied. Your API key may not have permission for this endpoint, or your account may be restricted.`,
    );
  }

  if (status === 429) {
    return new Error(
      `${base} — rate limited. Wait a moment and try /openrouter-sync again.`,
    );
  }

  if (status >= 500) {
    return new Error(
      `${base} — OpenRouter server error. This is on their end. Try /openrouter-sync again in a minute.`,
    );
  }

  return new Error(base);
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
  let piApiKey: string | undefined;
  if (ctx) {
    try {
      piApiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
    } catch (error) {
      // Key lookup failed (not configured, provider unknown, etc.) — fall through to env
      piApiKey = undefined;
    }
  }
  const resolved = piApiKey ?? process.env.OPENROUTER_API_KEY;
  return resolved && resolved !== "OPENROUTER_API_KEY" ? resolved : undefined;
}

function hasReasoning(model: OpenRouterModel): boolean {
  const params = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
  if (params.some((param) => ["reasoning", "include_reasoning", "reasoning_effort"].includes(String(param)))) {
    return true;
  }
  const text = `${stringValue(model.id) ?? ""} ${stringValue(model.name) ?? ""}`.toLowerCase();
  return (
    // 'qwen3' deliberately excluded: the family ships both reasoning and non-reasoning
    // variants, so name alone is ambiguous — rely on supported_parameters above.
    /(^|[\s/:_-])(r1|qwq|deepresearch|reasoning|thinking)([\s/:_-]|$)/.test(text) ||
    /\b(o1|o3|o4|gpt-5)\b/.test(text)
  );
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

function describeFetchError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s — OpenRouter may be down or slow. Try /openrouter-sync again.`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function statusText(auth: AuthStatus): string {
  return [
    `OpenRouter models: ${registeredCount}`,
    `last fetched: ${fetchedAt ? formatAge(Date.now() - fetchedAt) + " ago" : "never"}`,
    `last sync: ${lastSync.message}${lastSync.at ? ` (${formatAge(Date.now() - lastSync.at)} ago)` : ""}`,
    `auth: ${authStatus(auth)}`,
    ...(isAuthMissing(auth)
      ? ["⚠ requests need OPENROUTER_API_KEY or stored OpenRouter auth (run /login openrouter)"]
      : []),
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
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
