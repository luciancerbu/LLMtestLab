# Add a model

Add one JSON file per model. The id must match the model served by your local inference server.

```json
{"id":"qwen3:4b-instruct","name":"Qwen 4B","baseUrl":"http://127.0.0.1:11434/v1","reasoning":false,"input":["text"]}
```

Optional registry metadata can be declared explicitly:

```json
{"quantization":"Q4_K_M","contextWindow":32768,"hardware":{"platform":"darwin","architecture":"arm64","accelerator":"Apple Silicon GPU"}}
```

When omitted, the dashboard infers the provider/runtime and common quantization names where possible, and records `unknown` rather than inventing a value.

Ollama models use port 11434. Model definitions appear alongside the existing Pi Ollama definitions. Choose a separate configuration preset for sampling and token limits.

For a GGUF stored here, add `"runtime":"llama.cpp"`, `"file":"weights.gguf"`, a unique local `baseUrl`, and any supported `serverArgs`. LLM Test Lab starts its llama.cpp server in a separate tmux session on first launch, waits for `/health`, and then starts Pi. Set `LLAMA_SERVER_BIN` when the bundled runtime is absent.

Run `../refreshModels` from this directory, or `./refreshModels` from the project root, after copying GGUF files into `models/`. The scanner creates definitions for unregistered runnable GGUFs, assigns non-conflicting local llama.cpp ports, ignores auxiliary projection/imatrix files, and treats the first file of a split GGUF as the model entry.

The dashboard’s Hugging Face search lists public GGUF repositories and expands every repository into its available quantizations. Split files such as `00001-of-00002` and `00002-of-00002` are grouped into one download. Downloads are explicit, run in the background, land under `models/downloads/`, and trigger the same refresh scanner when complete.
