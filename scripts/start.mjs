// Dev launcher: runs Electron without ELECTRON_RUN_AS_NODE, which VS Code terminals set and which
// would otherwise make Electron behave like plain Node.
import { spawn } from "node:child_process";
import electron from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
