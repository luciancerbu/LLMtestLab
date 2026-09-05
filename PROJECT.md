# LLM Test Lab

A standalone local model-testing dashboard. Requires Node.js 22+, Pi and tmux on PATH. macOS uses macmon for power metrics and native Finder/Terminal buttons. Start with `npm start`; open http://127.0.0.1:4318. Validate with `npm run check`.

Add model-definition JSON files in `models/` (see its README). Configure the model in your running Ollama or local OpenAI-compatible server. Add test prompts in `prompts/`. Create/edit configuration presets in the dashboard, then select model + preset + prompt to start a test. Fresh runs use `runs/<id>`; editor/tool setup is the user's responsibility.

Optional environment variables: `PORT` (4318), `LLM_LAB_DATA_DIR` (project `data/`), `LLM_LAB_PROMPTS_DIR` (project `prompts/`), `LLM_LAB_RUNS_DIR` (project `runs/`), `PI_MODELS_PATH` (user `~/.pi/agent/models.json`), `PI_BIN` (`pi`), `TMUX_BIN` (`tmux`), `MACMON_BIN` (`macmon`). Executables resolve through PATH.

Settings are captured per launch in ignored runtime data. Active sessions retain their settings. The migrated benchmark keeps its original files and conversation via runtime metadata; clean installations need no LocalLLm workspace. Hardware readings are system-wide. macOS integration is intentional.
