# pi-openrouter-native

Live OpenRouter model sync for Pi using native `pi.registerProvider("openrouter", ...)`.

## Install

From this checkout:

```bash
pi -e .
```

After publish:

```bash
pi install npm:pi-openrouter-native
```

## Auth

Use env:

```bash
export OPENROUTER_API_KEY=sk-or-...
pi
```

Or run Pi `/login` and select OpenRouter. Pi stores key under `openrouter` in `~/.pi/agent/auth.json`.

Note: startup `/models` fetch can use `OPENROUTER_API_KEY` only because async extension factory has no command context. OpenRouter public `/models` works without key. `/openrouter-sync` can use Pi auth from `auth.json`.

## Commands

- `/openrouter-status` — model count, cache age, last sync, auth status
- `/openrouter-sync` — refetch `/models`, re-register provider, keep last-good list on failure

Pi model picker still lists OpenRouter models when no auth is configured because provider must be registered with `apiKey: "OPENROUTER_API_KEY"`. Requests need `OPENROUTER_API_KEY` or stored OpenRouter auth; `/openrouter-status` warns when missing.

## Usage/cost viewer

For burn-rate/model spend, install companion package:

```bash
pi install npm:@robhowley/pi-openrouter
```

Then use `/openrouter-usage`.

## Checks

```bash
npm run typecheck
npm audit --omit=dev
npm pack --dry-run
pi -e . --list-models
```
