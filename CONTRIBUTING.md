# Contributing

Use Node.js 20 or newer and pnpm 11. Run `pnpm check` before opening a change.
Changes to resource ownership must include cancellation and disposal tests.
Rendering changes must preserve deterministic inspection state, command parity
and WebGL context recovery.

Do not commit game assets, character models, proprietary runtimes, extracted
application content, generated package archives, or credentials.

Maintainers publish from GitHub releases through npm trusted publishing.
