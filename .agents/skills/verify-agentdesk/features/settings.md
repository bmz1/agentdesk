# Harness defaults

Settings lets a user choose the app's default harness and save each harness's model, permissions and extra instructions for future launches.

## Sub-features

- `settings-default`: default harness survives reload.
- `settings-profile`: mock model, instructions and ask permissions persist in daemon-owned settings.

## How to get to it (user POV)

- Choose the sidebar Settings link, then Agent harness defaults.

## Driving it with Playwright

Preconditions:

- Fresh helper-owned instance with passing doctor; no external harness required.

- **Run.** `node .agents/skills/verify-agentdesk/scripts/verify.mjs settings`.
- **Open.** `page.getByRole('link', { name: 'Settings', exact: true }).click()`; choose `mock` in `default-harness`, open `[data-testid="harness-mock"] summary`.
- **Edit and save.** Fill `harness-model-mock` with `mock-verification-model`, `harness-instructions-mock` with `Verify every change.`, select `ask` in `harness-permissions-mock`, then click `harness-defaults-save-mock`. Require status `Defaults saved.`.
- **Prove.** Reload and reopen the mock profile. Model/default selection must remain. Authenticated `GET /settings/harnesses` must return all three profile fields and `defaultHarness: mock`.
- **Evidence.** `settings-before-save.png`, `settings.png`, corresponding ARIA snapshots, `settings.json`, and `trace.zip` in the printed directory.

## Gotchas

- The mock details element is initially collapsed and must be opened again after reload.
- Saving a model alone does not verify the default harness or instructions; require the API assertions too.
- Re-detect and real-harness profiles are alternate settings actions, unverified by this path.
