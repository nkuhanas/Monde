import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  { stdio: "ignore" }
);

process.stdout.write(`${JSON.stringify({ child_pid: child.pid })}\n`);
setInterval(() => {}, 1000);
