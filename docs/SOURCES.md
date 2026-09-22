# Primary integration references

Reviewed 2026-09-22. These references inform the external request/response and hosting contracts, not claims about this application's measured model performance.

- TypeSafe HTTP endpoint, requests, responses, token usage and error codes: https://docs.typesafe.ai/api
- Choice options, instructions, probabilities and confidence: https://docs.typesafe.ai/primitives/choice
- Explicit model version used in the default configuration: https://docs.typesafe.ai/models
- Confidence semantics: https://docs.typesafe.ai/confidence
- Discord OAuth authorization-code flow, state, identify and application-command scopes: https://docs.discord.com/developers/topics/oauth2
- Discord signed HTTP interactions and guild/user context: https://docs.discord.com/developers/interactions/receiving-and-responding
- Cloudflare static assets and Worker deployment: https://developers.cloudflare.com/workers/static-assets/
- Cloudflare D1 binding and batch operations: https://developers.cloudflare.com/d1/worker-api/d1-database/

The original user-provided planning requirements are preserved as `original-requirements.md`. The delivered implementation follows that architecture, with native local SQLite support and additional rate/operations tables justified by the request for exhaustive analytics.

Game-space counts in the reports were computed locally and cross-checked by independent code. They are not copied model benchmark results.
