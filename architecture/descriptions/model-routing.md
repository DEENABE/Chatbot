Decides which logical agent handles a request and which installed Ollama model serves that agent, then runs inference through a single process-wide admission gate so local generation never overloads the machine.

**Status:** Implemented

## Responsibilities
- Intent classification (`services/intentRouter.js` → `classifyIntent`, `toTaskRoute`): routes to one of the agent profiles in `services/agentProfiles.js` — `general-chat`, `document-intelligence`, `windows-repair`, `os-control`, `app-automation`, `software-install`
- Model selection (`services/modelRouter.js` → `routeChatModel`, `discoverModels`, `resolveGeneralModel`): a profile lists *required declared capabilities* (e.g. `vision`, `tools`) and only *orders* eligible models by family hints; it never downloads or swaps models. Per-user choices in `model_preferences`, catalogue cache in `model_registry_snapshot`
- Route authority (`services/modelRouteAuthority.js` → `signWindowsProposal`): the backend signs a Windows-route proposal that the Electron side verifies (`frontend/tools/security/ModelRouteAuthority.js`) before any model-originated desktop tool runs
- Inference transport (`services/ollamaService.js` → `streamChat`, `embed`; `services/inferenceTransport.js`): first-token and idle timeouts (`CHAT_FIRST_TOKEN_TIMEOUT_SECONDS`, `CHAT_IDLE_TIMEOUT_SECONDS`) instead of a total timeout
- Admission control (`services/inferenceGate.js` → `InferenceGate`, max 8 queued, ≤240 s wait) and residency (`services/modelRuntime.js`, `services/gpuProfile.js` hardware detection)

## Tech Stack
- Ollama HTTP API, Node `fetch`, SQLite (preferences/registry)
