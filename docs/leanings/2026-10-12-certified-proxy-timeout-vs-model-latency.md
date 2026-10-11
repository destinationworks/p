# 2026-10-12 — Certified proxy timeout versus model latency

- **Status:** Resolved
- **Task/context:** Fresh certified four-task P/Pi/Kilo comparison on the same local orchestrator model.
- **Unexpected observation or failure:** Kilo resolved the required backend model, but the live startup request produced no response and the probe timed out after a socket reset.
- **Evidence:** The startup state recorded a successful model-resolution probe, then a 60-second request timeout with zero JSONL events. Kilo runtime logs recorded a socket close 30 seconds after the completion began. `certified-egress-proxy.ts` had a hard 30-second forwarding timer. A regression using a delayed model-bearing SSE response failed with `fetch failed` before the fix and passed afterward.
- **Approaches tried:**
  - **Attempt:** Run the documented certified command with installed Pi 0.86.1 and Kilo 7.7.5, a shared resolved model, and the Kilo alias.
    - **Outcome:** Did not work.
    - **Why:** The benchmark's proxy terminated a legitimate slow completion before the Kilo startup budget expired.
  - **Attempt:** Bind the proxy forwarding deadline to each bounded startup, instruction-parity preflight, or task cell.
    - **Outcome:** Worked in focused proxy regression tests.
    - **Why:** The response can outlive the old 30-second ceiling while the explicit candidate and overall benchmark deadlines still bound the run.
- **Root cause:** A transport-level 30-second ceiling contradicted the longer per-agent startup and task budgets, producing an infrastructure failure that looked like a model or agent failure.
- **Resolution:** Use validated, finite per-cell proxy completion deadlines, reject CLI cell budgets above the shared 24-hour cap before execution, and preserve the 30-second inbound request/header protection, containment, model checks, and absolute run deadline.
- **Verification:** Focused proxy and option-parity tests passed 15/15 after red regressions. One test proves a delayed model-bearing response survives beyond 30 seconds; another proves the configured deadline still terminates a stalled response. A fresh live 36-cell benchmark remains required; this record does not claim comparative success.
- **Prevention/follow-up:** `AGENTS.md` and `benchmarks/README.md` state the timeout contract; run a fresh certified matrix and retain raw evidence.
- **Reusable learning:** Benchmark transport timeouts must be compatible with the measured agent/model budget, or the harness can invalidate the very slow-model behavior it is supposed to compare.
- **References:** `benchmarks/src/harness/certified-egress-proxy.ts`; `benchmarks/src/workloads/benchmark-run.ts`; `benchmarks/test/harness/certified-proxy-cell-deadlines.test.ts`; `benchmarks/test/workloads/certification-option-parity.test.ts`.
