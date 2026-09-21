// Test fixture: file one pending human-input approval and print its id, so the
// CLI test has a question to answer.
//   node seed-approval.mjs <home> <projectId> <question>
import { openDev } from "../../../packages/core/src/index.ts";

const [home, projectId, question] = process.argv.slice(2);
const dev = openDev({ home });
const approval = dev.approvals.request({ projectId, action: "human-input", reason: question });
console.log(approval.id);
dev.close();
