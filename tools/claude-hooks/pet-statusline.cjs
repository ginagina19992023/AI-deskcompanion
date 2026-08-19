#!/usr/bin/env node
// Official Claude Code statusLine hook (https://code.claude.com/docs/en/statusline)
// -- NOT a private/reverse-engineered API. Two jobs:
// 1. Print a normal-looking status line to stdout (required -- Claude Code
//    replaces its default footer hints with whatever this prints, so
//    printing nothing or erroring leaves the user with a blank bar).
// 2. Side-effect: persist context-window + rate-limit numbers to disk so
//    the desktop pet's dashboard can show them without polling Claude Code
//    itself. This hook fires on its own cadence (message arrival, /compact,
//    permission-mode change, vim toggle) independent of pet-status.cjs's
//    event hooks, so it writes its own files rather than touching
//    pet-status.cjs's pet-sessions/<id>.json and risking a write race
//    between two separate Node processes.

const fs = require('fs');
const os = require('os');
const path = require('path');

const usageDir = path.join(os.homedir(), '.claude', 'pet-usage');
const accountRateLimitPath = path.join(os.homedir(), '.claude', 'pet-usage-account.json');

let input = '';
let done = false;
function finish() {
  if (done) return;
  done = true;
  let data = {};
  try {
    data = JSON.parse(input || '{}');
  } catch {
    data = {};
  }

  const model = data.model?.display_name ?? data.model?.id ?? '';
  const ctx = data.context_window ?? {};
  const usedPct = typeof ctx.used_percentage === 'number' ? Math.round(ctx.used_percentage) : null;
  const rate = data.rate_limits ?? {};
  const fiveHour = rate.five_hour?.used_percentage;
  const week = rate.seven_day?.used_percentage;

  // Side effect: persist for the dashboard. Never let a write failure stop
  // the status line text below from printing.
  try {
    fs.mkdirSync(usageDir, { recursive: true });
    if (data.session_id) {
      fs.writeFileSync(
        path.join(usageDir, `${data.session_id}.json`),
        JSON.stringify({
          sessionId: data.session_id,
          sessionName: data.session_name ?? null,
          cwd: data.workspace?.current_dir ?? data.cwd ?? null,
          model,
          contextUsedPercent: usedPct,
          contextWindowSize: ctx.context_window_size ?? null,
          totalInputTokens: ctx.total_input_tokens ?? null,
          ts: Date.now(),
        }),
      );
    }
    // Rate limits are account-wide, not per-session -- every session's hook
    // reports the same numbers, so this is deliberately one shared file
    // that whichever session last fired just overwrites (last-write-wins is
    // fine here since concurrent sessions should agree almost exactly).
    if (typeof fiveHour === 'number' || typeof week === 'number') {
      fs.writeFileSync(
        accountRateLimitPath,
        JSON.stringify({
          fiveHourUsedPercent: typeof fiveHour === 'number' ? fiveHour : null,
          fiveHourResetsAt: rate.five_hour?.resets_at ? rate.five_hour.resets_at * 1000 : null,
          weekUsedPercent: typeof week === 'number' ? week : null,
          weekResetsAt: rate.seven_day?.resets_at ? rate.seven_day.resets_at * 1000 : null,
          ts: Date.now(),
        }),
      );
    }
  } catch {
    /* dashboard just won't have fresh numbers this tick -- never worth breaking the real status line over */
  }

  // The actual status line text -- kept close to Claude Code's own
  // documented "rate limit usage" example so the terminal doesn't lose
  // information switching to a custom line, just gains the pet's own data
  // alongside it.
  const parts = [model || 'Claude'];
  if (usedPct !== null) parts.push(`context ${usedPct}%`);
  if (typeof fiveHour === 'number') parts.push(`5h ${Math.round(fiveHour)}%`);
  if (typeof week === 'number') parts.push(`7d ${Math.round(week)}%`);
  process.stdout.write(parts.join(' | '));
  process.exit(0);
}

process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 2000).unref();

