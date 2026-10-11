# 2026-10-12 — Kilo CLI omits model attribution in JSON turns

- **Status:** Resolved
- **Task/context:** Certified same-model P/Pi/Kilo comparison using the installed Kilo 7.7.5 CLI and the local orchestrator.
- **Unexpected observation or failure:** Kilo resolved the required backend model and returned the exact startup text, but its JSON `step_start`, `text`, and terminal `step_finish` events contained no model field. A CLI-only attribution gate rejected the startup before any scored task.
- **Evidence:** The live startup probe emitted a complete terminal event and the parent-owned proxy independently observed a request and model-bearing response for the expected resolved model. The original text-marker stop also discarded late events, but removing that stop alone did not reveal CLI model fields.
- **Approaches tried:**
  - **Attempt:** Retain Kilo events through process exit instead of stopping at the expected text marker.
    - **Outcome:** Partial.
    - **Why:** Terminal evidence was retained, but Kilo still did not emit model attribution.
  - **Attempt:** Accept absent Kilo CLI model fields only when the certified proxy validates every request and response against the expected model; reject contradictory or mixed CLI fields.
    - **Outcome:** Worked for the live Kilo startup and focused positive/negative regressions.
    - **Why:** Model identity comes from an independent, parent-owned wire boundary rather than a fabricated CLI field.
- **Root cause:** The installed Kilo JSON protocol omits response-model metadata for this provider even when its separate model-resolution command and upstream response identify the model.
- **Resolution:** Allow a Kilo-only, absent-CLI-model fallback in startup, parity, row schema, and certification evaluation, always paired with strict independent proxy evidence. P and Pi retain mandatory CLI attribution.
- **Verification:** The live Kilo startup passed on the expected resolved model; focused startup, wire-evidence, and receipt tests passed. A complete 36-cell certified comparison is still required and is not implied by startup success.
- **Prevention/follow-up:** `benchmarks/README.md` documents the attribution contract. Retain wrong-model, mixed-model, missing-proxy, and proxy-response mismatch regressions when updating Kilo or the harness.
- **Reusable learning:** A missing model field in an agent's JSON protocol is not proof of a different model; certify through independently captured per-request wire evidence, while treating any contradictory CLI attribution as a hard failure.
- **References:** `benchmarks/src/workloads/startup-probes.ts`; `benchmarks/src/workloads/certification.ts`; `benchmarks/test/workloads/kilo-startup-fail-closed.test.ts`; `benchmarks/test/workloads/certification-wire-model-evidence.test.ts`.
