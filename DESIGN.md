# DESIGN.md — HSP A2A Settlement Terminal

Durable visual decisions for the web console. Product truth lives in the README.

## Direction contract

- **THESIS:** A settlement terminal, not a dashboard. The surface owns one idea — *an
  autonomous agent paying another agent, with the human holding the two keys.* It refuses
  the SaaS card-grid and the hero-metric template; the payment pipeline itself is the page.
- **OWN-WORLD:** A cool ink-navy ops console. Lifted panels on an ink ground, 1px hairline
  seams, generous gutters. Color is **semantic state**, not decoration: amber = awaiting human
  authorization (the control moment), cyan = in flight, green = finalized, red = failed, slate =
  idle. Addresses, amounts and hashes are set in a system monospace (data, not costume). UI text
  in a refined system sans. No gradient text, no glass, no neon glow.
- **STORY:** A judge sees two agents exchange a payment mandate, watches the HSP flow light up
  stage by stage, is twice asked to authorize (and sees exactly what they authorize), and ends
  on a printed settlement receipt with the real status and tx hash.
- **FIRST VIEWPORT:** Left rail = the two agents across an A2A wire + the initiate panel.
  Center = the settlement pipeline (eight stages) as the hero. Right = the live event tape.
  The authorization gate rises over the center when the agent reaches a signing/submit step.
- **FORM:** Instrument/ops console. Proceeded unattended (no decision page, per the user's
  no-questions directive) with this committed direction; assumptions stated in-thread.

## Tokens (settled by the build)

- Ground `--ink: #0a0e1a`; panel `--panel: #111726`; raised `--panel-2: #161e30`;
  seam `--seam: #232c42`.
- Text `--fg: #e8edf7`; muted `--fg-dim: #97a3bd` (tinted from ground hue, never flat gray).
- State: `--awaiting:#f3b14e`, `--inflight:#3fc8e4`, `--ok:#45d08a`, `--fail:#f2667d`,
  `--idle:#4a5676`.
- Radii 10/14px; shadows carry offset + soft blur; motion is exponential ease-out from a
  visible default (≤320ms), one orchestrated moment per state change, honoring reduced-motion.

## Rules

- Mock vs live is always shown honestly; a mock run is never presented as a real payment.
- `token_total_raw` is always labeled raw units; any human amount is secondary.
- Every state has hover/disabled/active/empty/error; keyboard focus is visible on all controls.
