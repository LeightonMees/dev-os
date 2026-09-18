# Roadmap

Kept deliberately small. Long-term ideas live here as one line each, not as tickets.

## NOW

- Dogfood DEV on a real project (the user's own pass) and fix what it surfaces.
- First open-source release: publish the scrubbed tree, then fix whatever a stranger trips over.

## NEXT

- Interactive flows: n8n-style workflows of shell commands, AI prompts, human inputs, conditions and loops, with a canvas and a live run view (Executable Agent Workflows, "Flow editor V1").
- Worktree isolation per task run (git helpers exist; the runner works in place today).
- Approval gates on consequential actions (commit/push/deploy) using the existing approvals store.
- Codex structured output parsing (today Codex output is captured as text).

## LATER

- Design bridge: pull Figma frames and Modly meshes in as artifacts through Nexus, and push edits back.
- A 3D viewport for GLB/GLTF artifacts (they are stored and served today, but not drawn).
- Direct manipulation on the artifact canvas: select and edit elements inside an artboard, not just its source.
- Smarter worker routing from recorded execution outcomes.
- Screenshot/browser verification kind through the Nexus playwright server.
- Multiple projects in one auto-run; concurrency beyond one worker per repository.
