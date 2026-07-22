# Contributing

Issues and focused pull requests are welcome.

1. Fork the repository and create a branch.
2. Run `pnpm install`.
3. Add tests for behavior changes.
4. Run `pnpm check` and `pnpm pack --dry-run`.
5. Explain API or privacy tradeoffs in the pull request.

Keep the core provider-agnostic and dependency-light. New persistence or model integrations should normally be adapters rather than hard dependencies.
