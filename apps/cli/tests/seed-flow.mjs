// Test fixture: store one flow the way the control plane would, so the CLI test
// has something to list and run. Flows are authored in the app, not the CLI.
//   node seed-flow.mjs <home> <projectId> <command>
import { openDev } from "../../../packages/core/src/index.ts";

const [home, projectId, command] = process.argv.slice(2);
const dev = openDev({ home });
const flow = dev.flows.create({
  projectId,
  name: "greet",
  nodes: [{ id: "a", kind: "shell", label: "say", x: 0, y: 0, command }],
  edges: [],
});
console.log(flow.id);
dev.close();
