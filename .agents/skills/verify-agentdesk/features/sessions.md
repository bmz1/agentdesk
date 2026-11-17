# Approve and follow up with an agent

A user approves a mock agent's file write, observes a completed turn, and sends a follow-up retained in the conversation after reload.

## Sub-features

- `session-approve`: Allow releases the pending mock write and completes turn 1.
- `session-followup`: sending the next instruction completes turn 2 and persists the transcript.
- `session-isolation`: the file exists in the session worktree and not the original fixture repo.

## How to get to it (user POV)

- Create & start from the ticket dialog opens the session conversation.
- Existing tickets expose the Agent tab (`tab-agent`); Agents dashboard cards can open a session. Dashboard opening and Overview Start agent are additional entry paths requiring separate proof.

## Driving it with Playwright

Preconditions:

- Ticket journey completed with mock harness and ask permissions; approval visible.

- **Run.** `node .agents/skills/verify-agentdesk/scripts/verify.mjs sessions`.
- **Approve.** Click the button named exactly Allow within `approval-card`; wait for exact text `Done with turn 1.`.
- **Follow up.** Fill `composer-input` with `Also mention verification [noop]`; click `composer-send`; wait for `Done with turn 2.`.
- **Prove.** Reload, click `tab-agent`, and require the exact follow-up text. Read `GET /sessions`, require `AGENTDESK_NOTES.md` at the returned session `cwd`, and require no such file in the original repo. Copy the file to evidence before teardown.
- **Evidence.** `session-before-followup.png`, `sessions.png`, ARIA snapshots, `sessions.json`, `AGENTDESK_NOTES.md`, `trace.zip`.

## Gotchas

- `[noop]` is implemented by the existing mock adapter; here it skips the second write. It is not a general guarantee for a real harness.
- A completed turn leaves a resumable session; it does not mean the ticket is Done.
- This proves the app's mock adapter boundary, not real model execution. Approval denial, stop/resume and review feedback need separate journeys.
