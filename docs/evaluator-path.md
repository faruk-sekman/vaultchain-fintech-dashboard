# 60–90 second evaluator path

This is the shortest useful tour for a reviewer who does not want to provision a database before
understanding the product.

1. **Watch the flow (20 seconds):** open [`walkthrough.gif`](assets/demo/walkthrough.gif). It is a
   short loop built from the checked-in showcase screenshots: login → dashboard → customer list →
   MFA.
2. **Run locally (30–60 seconds):** use the zero-config Docker path in [`DOCKER.md`](../DOCKER.md)
   (`npm run demo`). It starts PostgreSQL, the API, the Angular app, and fictional seed data.
3. **Read the decisions (10 seconds):** scan the [architecture](architecture.md), then use the
   [security proof map](security-proof-map.md) to jump from each claim to its control and test.

No credential, API key, customer record, or external service is embedded in the visual asset. The
demo accounts shown in the root README are synthetic seed users for local evaluation only.
