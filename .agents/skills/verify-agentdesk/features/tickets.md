# Create and start a ticket

The project's plus button opens the create dialog (Thread form by default; the Ticket tab holds the ticket draft). Closing and reopening preserves the draft, and Create & start creates one ticket and launches its selected harness.

## Sub-features

- `ticket-draft`: title remains after Escape and reopening.
- `ticket-create-start`: a single ticket opens with a single mock session.

## How to get to it (user POV)

- Choose the project's plus button (`project-new-thread`).
- The global New ticket button (`new-ticket`) also opens the dialog; Create ticket (`ticket-create`) creates without starting. These alternate paths need separate proof.

## Driving it with Playwright

Preconditions:

- Settings and project journeys completed; mock is selected to avoid real agent work.

- **Run.** `node .agents/skills/verify-agentdesk/scripts/verify.mjs tickets`.
- **Retain draft.** Click `project-new-thread`, then `create-kind-ticket`; fill `ticket-title` with `Write verification notes`; press Escape; reopen, click `create-kind-ticket` again and assert the same title.
- **Start.** Select `mock` in `ticket-harness`; click `ticket-create-start`; wait for `ticket-heading` containing the title.
- **Prove.** `GET /tickets` returns exactly one ticket with the title; `GET /sessions` returns one mock session.
- **Evidence.** `ticket-before-create.png`, `tickets.png`, ARIA snapshots, `tickets.json`, `trace.zip`.

## Gotchas

- A pending mock write approval is expected at the end of this mode; cleanup stops that owned session via daemon shutdown.
- Start-failure retry behavior is covered in the existing broader E2E using an intercepted 503, not this map's successful start path.
- Never leave the inherited real-harness selection active when launching the fixture ticket.
- The dialog opens on the Thread form (`thread-prompt`); threads (read-only, off the board) are a separate journey.
