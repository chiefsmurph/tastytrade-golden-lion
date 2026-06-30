import net from "node:net";
import path from "node:path";

export const DEFAULT_IPC_SOCKET_FILENAME = ".tastytrade-golden-lion.sock";
export const DEFAULT_IPC_SOCKET_ENV_VAR = "TASTYTRADE_BOT_SOCKET";

export function getIpcSocketPath(options = {}) {
  const {
    cwd = process.cwd(),
    envVarName = DEFAULT_IPC_SOCKET_ENV_VAR,
    socketFileName = DEFAULT_IPC_SOCKET_FILENAME,
    socketPath,
  } = options;

  return socketPath ?? process.env[envVarName] ?? path.join(cwd, socketFileName);
}

export function sendIpcRequest(command, args = [], options = {}) {
  const socketPath = getIpcSocketPath(options);
  const payload = JSON.stringify({
    id: options.id ?? `${Date.now()}`,
    command,
    args,
  });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    function finish(callback, value) {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      callback(value);
    }

    socket.on("connect", () => {
      socket.write(`${payload}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const raw = buffer.slice(0, newlineIndex);

      try {
        const response = JSON.parse(raw);
        finish(resolve, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish(reject, new Error(`Invalid IPC response: ${message}`));
      }
    });

    socket.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      finish(
        reject,
        new Error(`Could not connect to IPC server at ${socketPath}: ${message}`),
      );
    });
  });
}

export async function sendIpcCommand(command, args = [], options = {}) {
  const response = await sendIpcRequest(command, args, options);

  if (!response.ok) {
    throw new Error(response.error || "IPC request failed");
  }

  return response.result;
}