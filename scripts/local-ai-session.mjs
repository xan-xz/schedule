import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serveBionicColumns } from "./bionic.mjs";

const execute = promisify(execFile);
const host = "127.0.0.1";
const modelPort = 1234;
const route = "/schedule/local-ai/columns";

export async function startLocalAiSession({
  model,
  runLms,
  fetcher,
  port = 4179,
  idleMs = 30_000,
}) {
  let claimed = false;
  let ownedPid;
  let boundPort;
  let expiry;
  let stopping;
  const status = async () =>
    JSON.parse(await runLms("daemon", "status", "--json"));

  async function prepare() {
    const previous = await status();
    if (previous.status === "running") {
      const api = JSON.parse(
        await runLms("server", "status", "--json", "--quiet"),
      );
      if (!api.running || api.port !== modelPort)
        throw Error(
          "The existing LM Studio session has a different API configuration",
        );
      return;
    }
    if (previous.status !== "not-running")
      throw Error("Unknown LM Studio status");
    const launched = JSON.parse(await runLms("daemon", "up", "--json"));
    if (
      launched.status !== "running" ||
      !launched.isDaemon ||
      !Number.isSafeInteger(launched.pid) ||
      launched.pid <= 0
    )
      throw Error("LM Studio did not start a headless session");
    ownedPid = launched.pid;
    await runLms(
      "server",
      "start",
      "--bind",
      host,
      "--port",
      String(modelPort),
    );
  }

  function stop() {
    if (stopping) return stopping;
    clearTimeout(expiry);
    server.close();
    stopping = (async () => {
      if (!ownedPid) return;
      const running = await status();
      if (running.isDaemon && running.pid === ownedPid)
        await runLms("daemon", "down");
    })();
    return stopping;
  }

  const server = createServer(async (request, response) => {
    if (request.url !== route) {
      response.writeHead(404).end();
      return;
    }
    let primary = false;
    await serveBionicColumns(request, response, {
      port: boundPort,
      model,
      fetcher,
      prepare: async () => {
        if (claimed) throw Error("A UniFlow preview is already running");
        claimed = primary = true;
        clearTimeout(expiry);
        await prepare();
      },
      beforeReply: async () => {
        if (primary) {
          response.setHeader("Connection", "close");
          await stop();
        }
      },
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  const closed = new Promise((resolve) => server.once("close", resolve));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      boundPort = server.address().port;
      server.off("error", reject);
      resolve();
    });
  });
  expiry = setTimeout(() => {
    void stop();
    server.closeAllConnections();
  }, idleMs);
  return { port: boundPort, closed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const model = process.env.UNIFLOW_BIONIC_MODEL;
  const lms = process.env.UNIFLOW_LMS_PATH;
  if (!model || !lms || !isAbsolute(lms)) {
    process.exitCode = 1;
  } else {
    try {
      const { closed } = await startLocalAiSession({
        model,
        runLms: async (...args) =>
          (
            await execute(lms, args, {
              windowsHide: true,
              timeout: 12_000,
              maxBuffer: 65_536,
            })
          ).stdout,
      });
      await closed;
    } catch (error) {
      if (error.code !== "EADDRINUSE") process.exitCode = 1;
    }
  }
}
