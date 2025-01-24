import { fork } from "child_process";
import * as core from "@actions/core";
import { setupServer } from "./server.js";

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  if (process.argv[2] == "child") {
    await setupServer();
  } else {
    Object.keys(process.env).forEach(function (key) {
      if (key.startsWith("ACTIONS_")) {
        core.info(`${key}=${process.env[key]}`);
        core.exportVariable(key, process.env[key]);
      }
    });

    if (!("ACTIONS_CACHE_SERVICE_V2" in process.env)) {
      core.warning(
        "Actions Cache Service v2 API is not enabled. Skip setting up shim."
      );
      process.exit(0);
    }

    const child = fork("dist/index.js", ["child"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });

    child.on("exit", (code) => {
      core.setFailed(`Server process exited with return code: ${code}`);
      process.exit(code);
    });

    child.on("error", (error) => {
      core.setFailed(`Server process error: ${error}`);
      process.exit(1);
    });

    child.on("message", (msg) => {
      core.info(`${msg}`);
      if (msg.kind === "ready") {
        const cacheUrl = `${msg.address}/`;
        core.exportVariable("ACTIONS_CACHE_URL", cacheUrl);
        core.info(`Server ready on ${cacheUrl}`);
        child.disconnect();
        process.exit(0);
      }
    });
  }
}
