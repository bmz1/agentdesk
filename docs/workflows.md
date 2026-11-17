# Workflow DSL

Workflows are versioned YAML files, validated with Effect Schema and compiled into an immutable execution plan. Runs pin the version they started with. To change a workflow, bump `version`.

```yaml
id: plan-implement-test-pr      # [a-z][a-z0-9_-]*
version: 1
name: Plan, implement, verify, draft PR
steps:
  - id: plan
    kind: agent
    harness: claude             # optional; else run override → ticket → project default
    prompt: plan.md             # file in prompts/ (or `instructions: inline text`)
    output: artifacts/plan.md   # final agent message saved as an artifact
  - id: approve_plan
    kind: approval
    title: Approve plan
    artifact: artifacts/plan.md # shown in the approval card
    onFailure: { retryStep: plan, maxAttempts: 3 }   # rejection re-plans with your feedback
  - id: implement
    kind: agent
    prompt: implement.md
    context: [artifacts/plan.md]
  - id: test
    kind: command               # runs in the worktree; defaults to the project's test command
    timeoutSec: 900
    onFailure: { retryStep: implement, maxAttempts: 2 }  # failing output is fed back to the agent
  - id: draft_pr
    kind: pull_request
    draft: true
    requiresApproval: true
```

Semantics:
- **agent**: a fresh harness session per attempt in the run's worktree. The prompt combines the ticket context, the step prompt, the `context` artifacts and, on a retry, feedback from the failed attempt. Tool approvals appear inline.
- **approval**: a durable gate. Approve to continue. Reject (with an optional note) to fail the step, which triggers `onFailure.retryStep` if configured.
- **command**: `sh -c` in the worktree. Output is stored as a check artifact. A non-zero exit fails the step.
- **pull_request**: an approval gate, then commit, push and open a draft PR through `gh` or `glab`. It is idempotent per branch and never merges. With no git provider configured, the changes are committed on the branch.
- `onFailure.maxAttempts` bounds how many times the failing step may fail before the run fails. A step's `retryStep` must not come after it.

You can edit and validate workflows under **Workflows** in the app, or use `POST /workflows` and `POST /workflows/validate`.
