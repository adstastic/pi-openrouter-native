# pi-openrouter-native plan

## Goal

Create small Pi package for proper OpenRouter support using Pi native provider registration and native `compat.openRouterRouting` plumbing.

Primary needs:
- Up-to-date OpenRouter model list in Pi model picker
- Manual refresh command
- Optional provider/quantization variants without custom stream monkeypatching
- Burn-rate / cost viewer, preferably by reusing or depending on focused usage package work

## Non-goals

- No custom `streamSimple` wrapper for OpenRouter routing
- No fake payload mutation after `before_provider_request`
- No duplicate full model-picker UI unless Pi built-in `/model` picker proves insufficient
- No API key storage flow initially; rely on Pi auth/env

## Baseline architecture

### Extension entry

`extensions/openrouter-native/index.ts`

Export async factory:

```ts
export default async function (pi: ExtensionAPI) {
  const models = await fetchOpenRouterModels();
  pi.registerProvider("openrouter", buildProviderConfig(models));
  registerCommands(pi);
}
```

Pi awaits async extension factories before startup, so models appear during startup and `pi --list-models`.

### Provider registration

Use Pi native provider API:

```ts
pi.registerProvider("openrouter", {
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "OPENROUTER_API_KEY",
  api: "openai-completions",
  models: openRouterModels.map(toPiModel),
});
```

Mapping:
- `id`: OpenRouter `id`
- `name`: OpenRouter `name ?? id`
- `reasoning`: derive from `supported_parameters` (`reasoning`, `include_reasoning`, `reasoning_effort`) plus known patterns
- `input`: `architecture.input_modalities` contains `image` => `["text", "image"]`; else `["text"]`
- `cost`: OpenRouter price per token × 1,000,000
- `contextWindow`: `context_length ?? 128000`
- `maxTokens`: `top_provider.max_completion_tokens ?? per_request_limits.completion_tokens ?? 16384`
- `compat`: keep minimal; Pi auto-detects OpenRouter by base URL and uses OpenRouter thinking format

## Commands

### `/openrouter-sync`

Refetch `/models`, rebuild provider, register again.

Behavior:
- Shows UI notification
- Uses timeout
- Keeps last good model list on fetch failure
- Invalidates cache when auth key changes

### `/openrouter-status`

Show:
- registered model count
- cache age
- last sync status
- current auth status if accessible

Use `pi.sendMessage` with custom type or `ctx.ui.notify`. If message is sent, filter custom info from LLM context.

### Optional `/openrouter-variants <model-id>`

Fetch `/models/{author}/{slug}/endpoints` and register provider/quantization route variants using native `compat.openRouterRouting`.

Clean variant design:
- Avoid fake model IDs with late payload rewrite.
- Prefer dynamic providers for routed variants.
- Keep real OpenRouter model IDs.

Example provider name:
- `openrouter-deepinfra-fp8`

Example model:

```ts
{
  id: "deepseek/deepseek-r1",
  name: "DeepInfra · fp8 — DeepSeek R1",
  compat: {
    openRouterRouting: {
      only: ["deepinfra"],
      allow_fallbacks: false,
      quantizations: ["fp8"],
    },
  },
}
```

Caveat:
- Same real model ID can appear under multiple provider names. Pi picker displays provider + model, so acceptable.

## Cost / burn-rate viewer

Two options:

### Option A: recommend companion package

Use `@robhowley/pi-openrouter` for `/openrouter-usage`.

Pros:
- Already focused on spend, caps, burn rate, top models, providers, day breakdowns
- Uses management key for analytics
- Keeps this package small

Cons:
- Separate install
- Need audit/fixes if package changes

### Option B: add minimal usage commands later

Add `/openrouter-usage` with:
- `GET /credits` for total credits/usage
- `GET /key` for current key spend/limits
- optional `GET /activity` when `OPENROUTER_MANAGEMENT_KEY` present

Env/auth:
- `OPENROUTER_MANAGEMENT_KEY` preferred for analytics/model breakdowns
- fallback to Pi `openrouter` auth / `OPENROUTER_API_KEY` for basic key data

MVP display:
- today / week / month usage
- projected monthly burn from trailing 7 days
- top models if activity available

## API clients

Use native `fetch`, no OpenRouter SDK dependency for MVP.

Reasons:
- Smaller install
- Less supply-chain surface
- Endpoints simple

Helpers:
- `fetchWithTimeout(url, init, timeoutMs = 15000)`
- `makeAuthHeaders(apiKey?)`
- `formatFetchError(response, context)`

## Cache strategy

Models:
- TTL: 30 min
- keyed by resolved API key hash
- never clear last good models until successful replacement

Endpoints:
- TTL: 30 min
- key by `apiKeyHash + modelId`

Usage:
- TTL: 30-60 sec
- no background timer in MVP unless overlay needs live refresh

## Security posture

- No shell exec
- No filesystem writes except package config if later added
- Do not log API keys
- Do not print redacted key prefixes unless useful and safe
- All API calls only to `https://openrouter.ai/api/v1`
- Use `AbortSignal.timeout` or `AbortController`
- Keep extension info messages out of LLM context

## Headers

For model calls Pi already adds attribution headers when telemetry enabled.

If package adds direct OpenRouter fetches, use:

```ts
{
  "Authorization": `Bearer ${apiKey}`,
  "HTTP-Referer": "https://github.com/<owner>/pi-openrouter-native",
  "X-OpenRouter-Title": "pi-openrouter-native",
}
```

Do not use obsolete `X-Title`.

## Package skeleton

```json
{
  "name": "pi-openrouter-native",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package", "pi", "openrouter"],
  "pi": {
    "extensions": ["./extensions/openrouter-native/index.ts"]
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "typescript": "^5.9.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

If custom TUI usage overlay gets added, declare `@mariozechner/pi-tui` explicitly.

## Milestones

### M1: live model provider

- Create package skeleton
- Implement `/models` fetch
- Implement conversion to Pi models
- Register OpenRouter provider at startup
- Add `/openrouter-sync`
- Typecheck
- Test with `pi -e . --list-models`

### M2: model metadata quality

- Improve reasoning detection
- Verify image support
- Verify costs vs OpenRouter docs
- Add `supported_parameters`-based compat where needed
- Add unit tests for conversion

### M3: route variants

- Fetch endpoints for selected model
- Register variant providers using `compat.openRouterRouting`
- Add `/openrouter-variants <model-id>`
- Add `/openrouter-preview <model-id>`
- No custom `streamSimple`

### M4: usage integration

Pick one:
- document companion `@robhowley/pi-openrouter`, or
- implement basic `/openrouter-usage`

If implementing:
- `/key`
- `/credits`
- `/activity` with management key
- simple dashboard or text report

### M5: polish/release

- README install/auth docs
- `npm pack --dry-run`
- `npm audit --omit=dev`
- License
- publish or git install path

## Test commands

```bash
npm run typecheck
npm audit --omit=dev
npm pack --dry-run
pi -e . --list-models
pi -e .
```

Manual checks inside Pi:

```text
/openrouter-status
/openrouter-sync
/model
```

Optional later:

```text
/openrouter-preview deepseek/deepseek-r1
/openrouter-variants deepseek/deepseek-r1
/openrouter-usage
```

## Open questions

- Package name: `pi-openrouter-native`, scoped package, or project-specific name?
- Include usage viewer here or require companion package?
- Variant providers naming scheme: stable but not too noisy?
- Should startup fetch be silent fallback to built-in models on failure, or block startup?

## Initial recommendation

Implement M1 only first. Use Pi built-in `/model` picker. Pair with `@robhowley/pi-openrouter` for burn-rate viewer if needed now. Add variants and built-in usage only after MVP proves useful.
