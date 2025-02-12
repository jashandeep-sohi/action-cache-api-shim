import { fork } from "child_process";
import * as core from "@actions/core";
import { setupServer } from "./server.js";
import { fileURLToPath } from "url";

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  if (process.argv[2] == "child") {
    await setupServer();
  } else {
    if (!("ACTIONS_CACHE_SERVICE_V2" in process.env)) {
      core.warning(
        "Actions Cache Service v2 is not enabled. Skip setting up shim."
      );

      if (core.getBooleanInput("require-v2")) {
        core.setFailed("Actions Cache Service v2 is required");
        process.exit(1);
      }

      exportActionsVariables();
      process.exit(0);
    }

    const __filename = fileURLToPath(import.meta.url);

    const child = fork(__filename, ["child"], {
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
      if (msg.kind === "ready") {
        const cacheUrl = `${msg.address}/`;

        core.info(`Serving on ${cacheUrl}`);

        process.env.ACTIONS_CACHE_URL = cacheUrl;
        exportActionsVariables();

        child.disconnect();
        process.exit(0);
      }
    });
  }
}

function exportActionsVariables() {
  Object.keys(process.env).forEach(function (key) {
    if (key.startsWith("ACTIONS_")) {
      core.info(`${key}=${process.env[key]}`);
      core.exportVariable(key, process.env[key]);
    }
  });
}
