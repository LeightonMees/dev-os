#!/usr/bin/env node
// Entry point for the `dev` command. Node 24+ runs the TypeScript sources directly.
const { main } = await import("../src/main.ts");
const code = await main(process.argv.slice(2));
process.exitCode = code;
