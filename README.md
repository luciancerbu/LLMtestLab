# LLM Test Lab

Standalone dashboard for testing local models with selectable configuration presets, autonomous Pi sessions in tmux, and hardware monitoring. GGUF weights placed in `models/` can be paired with a JSON definition and launched through the bundled llama.cpp runtime; large weights and runtime binaries remain outside Git. New sessions use an isolated folder under `runs/` by default, or a folder selected with the native macOS picker. Sessions can be opened in Finder or removed from the dashboard; removal closes that Pi tmux session and preserves the project folder and its files. Every new Pi launch receives an autonomous benchmark instruction so it keeps working, makes routine in-scope decisions, and verifies the result without waiting for unnecessary confirmation.

The Quick benchmark runs the three cases in `prompts/quick-suite.json` directly against the selected model, sequentially and without Pi tools or MCP. It records wall-clock request latency and the prompt, completion, and total token counts reported by the model server. Results are retained locally in `data/quick-suites.json`.

Use **Refresh model folder** after placing GGUF files in `models/`, or run `./refreshModels` from Terminal. **Search Hugging Face** searches public GGUF repositories, shows all runnable quantizations in each result, groups split shards, and downloads only after explicit confirmation. Download progress is saved locally; completed weights are registered automatically.

Appearance can be set to **Auto**, **Light**, or **Dark** in Settings. Auto follows the current macOS color-scheme preference and updates immediately when the system appearance changes. The choice is stored locally in the browser, and the theme is resolved before the stylesheet loads to prevent a light/dark flash during startup.

The interface uses a dark Azure visual direction adapted from the MIT-licensed ThreeUI Community project. See `THIRD_PARTY_NOTICES.md`.

See [PROJECT.md](PROJECT.md) for setup, configuration and the test workflow. Run `npm start` and open http://127.0.0.1:4318.
