#!/usr/bin/env node

// Start Claude Code with the Harvest Channels scope already on.
//
// Harvest sends meeting events — someone spoke, someone joined, the screen changed — over an MCP
// channel, and Claude Code only listens on channels a session was launched with. Every agent that
// forgot the flag looked like a broken product: the bot sat in the meeting and never woke up. The
// flag is not something a user should have to remember, so it lives here.
//
//   harvest-hosted claude [any claude arguments]
//
// Everything after `claude` is forwarded untouched and in order, the working directory is the one
// the user was in, and Claude's exit status is this process's exit status. Nothing about the
// credential goes through here: authorization stays in the MCP headers helper the installer wrote,
// so a token can never appear in a process listing.

import { spawn } from 'node:child_process';

const CHANNEL_SCOPE = 'server:harvest-hosted';
const CHANNEL_FLAG = '--dangerously-load-development-channels';

export function buildClaudeArgs(userArgs) {
  // The flag goes first so a user argument can never end up as its value, and it is not repeated if
  // the caller already passed it themselves.
  const alreadyScoped = userArgs.some(
    (arg, index) => arg === CHANNEL_FLAG && userArgs[index + 1] === CHANNEL_SCOPE,
  );
  return alreadyScoped ? [...userArgs] : [CHANNEL_FLAG, CHANNEL_SCOPE, ...userArgs];
}

export function claudeCommand(platform = process.platform) {
  return platform === 'win32' ? 'claude.cmd' : 'claude';
}

export function runClaude(userArgs, options = {}) {
  const command = claudeCommand();
  const args = buildClaudeArgs(userArgs);
  const child = spawn(command, args, {
    // No cwd override: the point is that Claude opens the directory the user is standing in.
    stdio: 'inherit',
    env: process.env,
    shell: false,
    ...options,
  });

  child.on('error', (error) => {
    const detail = error?.code === 'ENOENT'
      ? 'Claude Code CLI was not found in PATH — install it from https://claude.com/claude-code'
      : String(error?.message || error);
    console.error(`harvest-hosted: ${detail}`);
    process.exit(127);
  });

  child.on('exit', (code, signal) => {
    // A signalled child is reported the way a shell reports it, so scripts wrapping this see the
    // same status they would have seen running Claude directly.
    if (signal) process.exit(128 + (typeof signal === 'number' ? signal : signalNumber(signal)));
    process.exit(code === null ? 1 : code);
  });

  return child;
}

function signalNumber(signal) {
  const known = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return known[signal] ?? 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) runClaude(process.argv.slice(2));
