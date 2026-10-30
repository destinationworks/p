# 2026-10-31 — Duplicate embedding servers piled up under memory pressure

- **Status:** Resolved (live daemon not yet restarted onto the fix; see follow-up)
- **Task/context:** The user saw several Python processes of about 1.7 GB each in Activity Monitor on a 24 GB Mac that was swapping heavily (load average above 200, free memory under 100 MB, disk 100% full). They were children of the installed indexing daemon (`com.dst.p.code-index`).
- **Unexpected observation or failure:** Four `embedding_server.py --port 18742 --model Qwen/Qwen3-Embedding-0.6B` processes ran at once and only one held the port. The others had loaded the model and never exited. After three were killed, another appeared within two minutes. `service.log` had grown to 261 MB, mostly from an earlier restart storm (86%) plus Qdrant INFO access lines.
- **Evidence:** `lsof -iTCP:18742` showed one listener (PID 70075). `ps` showed the extra servers as children of the daemon with ages from 19 to 30 minutes. `service.log` repeated "Starting embedding server", "Loading model", and "Embedding server already running" in tight sequences.
- **Approaches tried:**
  - **Attempt:** Treat it as a transient and kill the duplicates.
    - **Outcome:** Partial
    - **Why:** It freed about 5 GB but the daemon spawned a new duplicate within two minutes, so the trigger was still live.
  - **Attempt:** Fix only the Python side (claim the port before loading the model).
    - **Outcome:** Partial
    - **Why:** A duplicate then exits quickly without weights, but the daemon still spawned one on every slow `/health`, and the stdlib `torch` import cost remains.
- **Root cause:** `EmbeddingServerManager.start()` decided "the server is down" from one 2 s `/health` probe. Under memory pressure a healthy but busy server, or one still loading the model, misses that deadline. The manager then spawned another process, overwrote `this.child` (losing its handle on the earlier child), and each new process loaded the full model before discovering that `bind` failed, because `main()` loaded the model before it created the listening socket.
- **Resolution:** The manager now waits for readiness when its own child is alive or when anything accepts TCP connections on the port (only `ECONNREFUSED` means the port is free), with the remaining startup budget as the health timeout, honoring the abort signal. The Python server binds first and exits with code 98 without loading the model if the port is taken. Qdrant now logs at WARN. `reinstall.sh` archives service logs over 50 MB with Brotli Q6 and truncates them in place.
- **Verification:** `packages/code-index/test/embedding-server-busy-port.test.ts` (own slow child, foreign slow listener, abort during the wait, occupied port that never becomes ready) failed before the change and passes. `test_embedding_port_claim.py` covers the bind-first ordering. `scripts/indexing-service-log-archive.test.js` covers the archiver.
- **Prevention/follow-up:** The fix takes effect once `./reinstall.sh` runs and the daemon restarts. The `npu` Core AI worker crashing at startup was the source of the earlier restart storm and is separate. A zombie child seen right after `kill` is libuv reaping on the daemon's next event-loop turn, which a starved daemon delays; no code change.
- **Reusable learning:** A health probe that times out is not evidence that a process is gone. Before spawning a replacement, check whether the port or the child you already own is alive, and make the child claim its resource before it does expensive work.
- **References:** `packages/code-index/src/embed/server.ts`, `packages/code-index/embedding_server.py`, `packages/code-index/embedding_http_server.py`, `scripts/indexing-service-log-archive.js`, `reinstall.sh`.
