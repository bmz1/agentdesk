# Register a project

A user registers a git repository as a project and reaches its ticket board, with the selected harness stored for later work.

## Sub-features

- `project-register`: save a valid repository and mock harness.
- `project-persist`: project board and stored registration survive reload.

## How to get to it (user POV)

- Choose the sidebar Manage projects link (`a[aria-label="Manage projects"]`) and use Register project.
- Project settings supports later edits; that alternate path is not exercised here.

## Driving it with Playwright

Preconditions:

- Settings journey completed; helper-created git repo has an initial main-branch commit and local identity.

- **Run.** `node .agents/skills/verify-agentdesk/scripts/verify.mjs projects`.
- **Register.** Click `a[aria-label="Manage projects"]`; fill `project-name` with `Verification Project` and `project-repo` with the helper's scratch repo path; select `mock` in `project-harness`; click `project-save`.
- **Observe.** Wait for `page.getByTestId('board').waitFor()`.
- **Prove.** `GET /projects` must return exactly one project with the expected name, canonical repo path and mock default harness. Reload; the board must return.
- **Evidence.** `project-before-save.png`, `projects.png`, corresponding ARIA snapshots, `projects.json`, `trace.zip`.

## Gotchas

- The daemon canonicalizes repo paths: macOS `/var/...` may be stored as `/private/var/...`. Compare to `realpathSync(repo)`.
- Native Browse requires Electron's bridge; type the path in browser verification.
- Existing user repos are not fixtures; only register the disposable repo in this journey.
