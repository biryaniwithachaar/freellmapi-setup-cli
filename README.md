# freellmapi-setup-cli

A cross-platform (**Windows, macOS, Linux**) interactive CLI add-on for [FreeLLMAPI](https://freellmapi.co) that:

1. **Scrapes the live catalog** (`https://api.freellmapi.co/v1/latest` / `https://freellmapi.co/models`) and exports all providers & models grouped cleanly into `catalog-providers.json`.
2. **Classifies providers & models** by quota style (`Keyless`, `High Quota`, `Moderate`, `Credit Wallet`, `Strict Cap`), context window (`128K`–`1M`), parameter tier, and tool capability.
3. **Filters out clutter & tiny models** (safety/guard models like `Prompt Guard`/`Llama Guard`/`Qwen3Guard`, TTS/image/embedding routes, `<7B` peanut models, and `<32K` windows).
4. **Builds budget-balanced chains** (`frontier-heavy`, `balanced-daily`, `fast-pool`) where each unique model is assigned **once** to the best-fit provider so you don't exhaust a single provider's quota.
5. **Auto-checks & updates chains** on startup and after adding any provider.

---

## Quick Install (Any FreeLLMAPI Setup)

### Option A: Drop into your `freellmapi` folder
1. Copy `freellmapi-setup-cli.mjs` into your `freellmapi/scripts/` folder (or the root of your `freellmapi` repo).
2. Make sure FreeLLMAPI is built once (`npm run build:server` if you haven't started it yet).
3. Run from your `freellmapi` folder:
   ```bash
   node scripts/freellmapi-setup-cli.mjs
   ```

### Option B: Run from anywhere pointing at your DB
```bash
node freellmapi-setup-cli.mjs --db /path/to/freellmapi/server/data/freeapi.db
```

---

## CLI Flags

| Flag | Description |
| :--- | :--- |
| `--db <path>` | Explicit path to `freeapi.db` (auto-detected if run inside your FreeLLMAPI repo) |
| `--scrape-only` | Scrape `freellmapi.co/models` and save `catalog-providers.json` without prompts |
| `--check-chains` | Inspect local chains vs. recommended budget-balanced chains and exit |
| `-h, --help` | Show usage help |

## Requirements
* Node.js `>= 20.18`
* Existing FreeLLMAPI checkout (`better-sqlite3` + `server/dist` built via `npm run build:server`)

