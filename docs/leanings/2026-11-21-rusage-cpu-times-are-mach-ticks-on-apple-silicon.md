# 2026-11-21 — proc_pid_rusage CPU times are Mach ticks on Apple silicon

- **Status:** Resolved
- **Task/context:** Adding CPU, memory and GPU figures for the indexing daemon's process tree to the macOS tray (`packages/coding-agent/src/tray/macos/resource_sampler.swift`).
- **Unexpected observation or failure:** `ri_user_time` and `ri_system_time` from `proc_pid_rusage` are named and documented like nanoseconds, but on Apple silicon they are Mach absolute-time ticks. Used as nanoseconds, a busy process shows about 1.3% CPU where `ps` shows about 50%.
- **Evidence:** `mach_timebase_info` on an M4 returns 125/3. A prototype that multiplied the tick deltas by 125/3 matched `ps -o %cpu` to within 0.1 percentage points for the daemon, Qdrant and the embedding server. With the conversion removed, a busy-loop child that used a full core measured 1.29%.
- **Approaches tried:**
  - **Attempt:** Treat the rusage times as nanoseconds.
    - **Outcome:** Did not work
    - **Why:** On arm64 the counters tick at 24 MHz, so the values come out 41.67 times too low. Intel Macs use a 1/1 timebase, which hides the bug there.
  - **Attempt:** Convert tick deltas with `mach_timebase_info`, measuring the sample interval on the same monotonic clock (`DispatchTime.uptimeNanoseconds`).
    - **Outcome:** Worked
    - **Why:** Both the counters and the clock then use the same time base, and neither advances during sleep.
- **Root cause:** The XNU rusage CPU-time fields store raw Mach absolute time. They are nanoseconds only where the timebase is 1/1.
- **Resolution:** `machTicksToNanoseconds` in `resource_sampler.swift` converts both CPU fields, with an overflow-safe fallback to floating point. The sampler takes its timestamp right before it reads the counters.
- **Verification:** `packages/coding-agent/test/indexing-tray-macos-resource-sampler.test.ts` compiles the real sampler and measures a live node parent with a busy child. It asserts that the sampled cumulative CPU time of the child lies between two `ps -o time=` readings taken before and after the sampler ran. Removing the conversion fails this assertion. A first version asserted a CPU rate above 5% instead, and it flaked: on a host with a load average near 240, the busy child got about 1.3% of a core. Live tray readings matched Activity Monitor.
- **Prevention/follow-up:** Pin units with a load-independent cross-check against an independent counter, such as `ps` cumulative CPU time. A rate threshold depends on how much CPU the host grants and cannot do this.
- **Reusable learning:** On macOS, convert any `proc_pid_rusage` or `proc_pidinfo` CPU time with `mach_timebase_info` before treating it as nanoseconds. Verify per-process CPU figures against `ps` on Apple silicon, not on Intel. For memory, use `ri_phys_footprint`, the figure Activity Monitor shows. The resident size of the MPS embedding server read 70 MB against a 1.8 GB footprint, because unified-memory Metal buffers and compressed pages are not resident.
- **References:** `packages/coding-agent/src/tray/macos/resource_sampler.swift`, `packages/coding-agent/test/indexing-tray-macos-resource-sampler.test.ts`, `packages/coding-agent/docs/code-indexing.md` (Menu bar and system tray).
