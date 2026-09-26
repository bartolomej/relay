import { execFile } from "child_process";

/**
 * Seconds since the last keyboard, mouse or trackpad input on this Mac.
 * Using Relay from the phone doesn't count. Undefined off macOS or when
 * it can't be read.
 */
export function idleSeconds(): Promise<number | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const m = /"HIDIdleTime" = (\d+)/.exec(stdout || "");
      resolve(err || !m ? undefined : Number(m[1]) / 1e9);
    });
  });
}
