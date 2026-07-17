# Contributing

Thanks for considering a contribution to `openclaw-whatsapp-cloud`.

## Getting set up

This project uses [mise](https://mise.jdx.dev) to pin the Node version and provide task shortcuts. Install it, then:

```bash
git clone https://github.com/shqear93/openclaw-whatsapp-cloud.git
cd openclaw-whatsapp-cloud
mise install       # installs the pinned Node version
mise run install    # npm ci
mise run test
```

Without mise, plain `npm ci && npm test` on Node.js 20+ works the same.

Run `mise tasks` to see everything available (`install`, `test`, `typecheck`, `build`, `push-ci-secrets`).

## Making changes

- Keep changes focused — one logical change per PR.
- Add or update tests for any behavior change. The suite is the safety net for a plugin that talks to a real, external, rate-limited API; untested changes here are risky in a way they might not be elsewhere.
- Run `mise run test` and `mise run typecheck` before opening a PR.
- If your change affects the plugin's design or delivery model, update [`ARCHITECTURE.md`](./ARCHITECTURE.md) alongside the code — it's meant to always reflect the as-built system, not the original intent.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, etc.) — releases and the changelog are generated automatically from these via [release-please](https://github.com/googleapis/release-please), so consistent prefixes matter more here than in a typical repo.

## Reporting bugs

Please include:

- What you expected vs. what happened.
- Relevant log output (redact tokens/phone numbers).
- Your OpenClaw version and this plugin's version.

## Security

Please don't open a public issue for security vulnerabilities (e.g. webhook signature bypass, credential handling). Email the maintainer instead — see the repository owner's profile for contact info.
