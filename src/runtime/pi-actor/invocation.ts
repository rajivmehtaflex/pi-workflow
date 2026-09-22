export interface PiInvocationOptions {
  runningScript?: string;
  fallbackExecutable?: string;
  sessionPath: string;
  prompt: string;
  model?: string;
  thinking?: string;
  systemPromptPath?: string;
}

export interface PiInvocation {
  executable: string;
  args: string[];
}

export function resolvePiInvocation(options: PiInvocationOptions): PiInvocation {
  const args: string[] = options.runningScript === undefined ? [] : [options.runningScript];
  args.push("--mode", "json", "-p", "--session", options.sessionPath, "--no-extensions");
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.thinking !== undefined) args.push("--thinking", options.thinking);
  if (options.systemPromptPath !== undefined)
    args.push("--append-system-prompt", options.systemPromptPath);
  args.push(options.prompt);
  return {
    executable:
      options.runningScript === undefined ? (options.fallbackExecutable ?? "pi") : process.execPath,
    args,
  };
}
