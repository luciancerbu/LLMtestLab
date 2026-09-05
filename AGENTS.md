# LLM Test Lab

Keep this project independent of any particular workspace, model or benchmark application. Paths belong in settings/environment variables or ignored run metadata. Never auto-start inference as part of UI verification. Preserve existing run files and conversations.

Use `npm run check` after code changes. Verify changed UI in the browser. Model and configuration selections must affect actual launch settings; keep a per-run snapshot. macOS native integration is intentional; report unavailable telemetry clearly.
