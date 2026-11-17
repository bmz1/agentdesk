import { tmpdir } from "node:os"
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Exit, Schedule, Scope, Stream } from "effect"
import { NodeProcessLayer, runCommand, spawnManaged } from "../src"

layer(NodeProcessLayer, { excludeTestServices: true })("process supervision (effect/process)", (it) => {
  it.effect("runCommand collects output, feeds stdin and strips credentials", () =>
    Effect.gen(function* () {
      process.env.GH_TOKEN = "should-not-leak"
      const r = yield* runCommand("sh", ["-c", 'cat; echo "[$GH_TOKEN]" >&2'], { input: "piped" })
      expect(r).toEqual({ code: 0, stdout: "piped", stderr: "[]\n" })
      expect((yield* runCommand("sh", ["-c", "exit 7"])).code).toBe(7)
      expect((yield* runCommand("definitely-not-a-binary", [])).code).toBe(-1)
      expect((yield* runCommand("sleep", ["5"], { timeoutMs: 100 })).code).toBeNull()
      delete process.env.GH_TOKEN
    })
  )

  it.effect("spawnManaged streams lines, writes stdin and kills the process group on scope close", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const proc = yield* spawnManaged({
        harness: "test",
        command: "sh",
        args: ["-c", "sleep 30 & while read l; do echo got:$l; done"],
        cwd: tmpdir(),
        killGraceMs: 200
      }).pipe(Scope.provide(scope))
      yield* proc.write("one\n")
      const first = yield* proc.lines.pipe(Stream.take(1), Stream.runCollect)
      expect(first).toEqual(["got:one"])
      yield* Scope.close(scope, Exit.void)
      yield* proc.exited // completes even though the watcher's scope is closed
      // The background `sleep` shared the process group and was terminated too.
      const probe = runCommand("sh", ["-c", `kill -0 -${proc.pid} 2>/dev/null && echo alive || echo gone`]).pipe(
        Effect.map((r) => r.stdout.trim())
      )
      // Signal delivery is asynchronous: poll briefly for the group to disappear.
      const state = yield* probe.pipe(
        Effect.repeat({ until: (s) => s === "gone", schedule: Schedule.spaced("50 millis"), times: 40 })
      )
      expect(state).toBe("gone")
    })
  )

  it.effect("reports not_installed for missing binaries", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(spawnManaged({ harness: "x", command: "/nonexistent/bin", args: [], cwd: tmpdir() }))
      expect(JSON.stringify(exit)).toContain("not_installed")
    })
  )
})
