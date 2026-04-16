import { basename } from "node:path";

import type { ToolExecutionInput } from "../types.js";

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function normalizeCommandSignature(command?: string): string | null {
  if (!command || command === "stdin" || command.startsWith("reduce:")) {
    return null;
  }

  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return null;
  }

  const first = tokens[0];
  if (!first) {
    return null;
  }

  const normalized = basename(first.replace(/^["']|["']$/gu, ""));
  return normalized || null;
}

export function normalizeExecutionInput(input: ToolExecutionInput): ToolExecutionInput {
  if (input.argv?.length || !input.command) {
    return input;
  }

  const argv = tokenizeCommand(input.command);
  if (argv.length === 0) {
    return input;
  }

  return {
    ...input,
    argv,
  };
}
