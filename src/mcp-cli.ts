import path from "node:path";
import { startCognitiveKernelsMcpServer } from "./mcp/control-plane.js";

type ParsedArgs = {
  flags: Map<string, string | boolean>;
};

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.flags.has("--help")) {
    printUsage();
    return;
  }

  await startCognitiveKernelsMcpServer({
    defaultCwd: path.resolve(readStringFlag(parsed.flags, "--cwd") ?? process.cwd()),
    defaultConfigPath: readStringFlag(parsed.flags, "--config"),
    runManagerOptions: {
      runsRoot: readStringFlag(parsed.flags, "--runs-root"),
      scriptPath: readStringFlag(parsed.flags, "--script-path"),
    },
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    if (token === "--help") {
      flags.set(token, true);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Expected a value after ${token}`);
    }
    flags.set(token, value);
    index += 1;
  }

  return { flags };
}

function readStringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  cognitive-kernels-mcp [--cwd <path>] [--config <path>] [--runs-root <path>] [--script-path <path>]",
    ].join("\n") + "\n",
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
