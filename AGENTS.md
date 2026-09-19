# XYX repository instructions

Read `docs/XYX_MONAD_PRD.md` before changing product behavior. This repository targets Monad Testnet only. Verify current chain, token, wallet, gas, and deployment facts against the official Monad documentation before using them. `docs/monad-for-llms.odt` is an index, not a substitute for live documentation.

Never claim a testnet action happened from fixtures, a local test, or a prepared transaction. The `/demo` page must show an empty or unverified state until real receipts and contract state are observed. Keep buyer, provider, evaluator, and relayer keys separate and out of Git.

The contracts are Solidity/Foundry. Run `npm run test:contracts`, `npm test`, `npm run typecheck`, and `npm run build:web` after relevant changes. The Next.js instructions in `apps/web/AGENTS.md` also apply to the web app.
