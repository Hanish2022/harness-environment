function timestamp(): string {
  return new Date().toLocaleTimeString();
}

export function doggieLine(text: string): void {
  console.log(`[${timestamp()}] \u{1F415} DOGGIE: ${text}`);
}

export function info(text: string): void {
  console.log(`[${timestamp()}] ${text}`);
}

export function warn(text: string): void {
  console.warn(`[${timestamp()}] ⚠️  ${text}`);
}

export function errorLine(text: string): void {
  console.error(`[${timestamp()}] ❌ ${text}`);
}

export function notImplemented(command: string, phase: string): void {
  console.log(
    `\u{1F415} DOGGIE: \`${command}\` is not implemented yet — it lands in ${phase} (see TASKS.md). ` +
      `Phase 1 currently covers the floating avatar and lifecycle commands only.`
  );
}
