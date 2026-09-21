# Roadmap

Kept deliberately small. Long-term ideas live here as one line each, not as tickets.

## NOW

- Dogfood DEV on a real project (the user's own pass) and fix what it surfaces.
- First open-source release: publish the scrubbed tree, then fix whatever a stranger trips over.

## NEXT

- Interactive flows: n8n-style workflows of shell commands, AI prompts, human inputs, conditions and loops, with a canvas and a live run view (Executable Agent Workflows, "Flow editor V1").
- Approval gates on push and deploy (commits are gated today via `approvals.requireForCommit`).
- Codex structured output parsing (today Codex output is captured as text).

## LATER

- Design bridge: pull Figma frames and Modly meshes in as artifacts through Nexus, and push edits back (the GLB viewport is in place; the bridge waits on Nexus stdio working from DEV).
- Direct manipulation on the artifact canvas: select and edit elements inside an artboard, not just its source.
- Screenshot/browser verification kind through the Nexus playwright server.
- Multiple projects in one auto-run; concurrency beyond one worker per repository.
