import { runRealMCPDemo } from './real-mcp-diagnostics.js';

const outcome = await runRealMCPDemo();
if (outcome.exitCode === 0) console.log(outcome.message);
else console.error(outcome.message);
process.exitCode = outcome.exitCode;
