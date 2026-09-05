# Test configurations

Create or edit presets in the dashboard, or add a JSON file here. Presets are separate from model definitions and refresh automatically. IDs use lowercase letters, digits and hyphens. `maxTokens` must be smaller than `contextWindow`.

Each launch generates a Pi provider extension and records its configuration in the run metadata. Sampling parameters are sent to the local OpenAI-compatible endpoint. Context window describes Pi's token budget; set the actual inference server context capacity separately.
