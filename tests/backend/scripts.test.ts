import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LIST_SCRIPT,
  STATUS_SCRIPT,
  appActionScript,
  cleanAppKey,
  cleanComm,
  cleanNice,
  cleanPid,
  cleanRunUser,
  cleanSignal,
  detailScript,
  logScript,
  managersScript,
  parseTarget,
  reniceScript,
  signalScript,
} from "../../src/backend/scripts";
import type { LogTarget } from "../../src/shared/types";

function syntaxOk(script: string): boolean {
  const run = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return run.status === 0;
}

describe("input checks", () => {
  it("accepts real pids only", () => {
    expect(cleanPid("812")).toBe(812);
    for (const bad of ["1", "0", "-5", "abc", "1.5", "99999999"]) {
      expect(() => cleanPid(bad)).toThrow();
    }
  });

  it("accepts a fixed list of signals", () => {
    expect(cleanSignal("sigterm")).toBe("TERM");
    expect(cleanSignal("KILL")).toBe("KILL");
    expect(() => cleanSignal("9; rm -rf /")).toThrow();
    expect(() => cleanSignal("ABRT")).toThrow();
  });

  it("limits the priority", () => {
    expect(cleanNice("-5")).toBe(-5);
    expect(() => cleanNice("20")).toThrow();
    expect(() => cleanNice("1.5")).toThrow();
  });

  it("checks app names", () => {
    expect(cleanAppKey("pm2", "3")).toBe("3");
    expect(cleanAppKey("supervisor", "web:web_00")).toBe("web:web_00");
    expect(() => cleanAppKey("pm2", "a b")).toThrow();
    expect(() => cleanAppKey("supervisor", "x; reboot")).toThrow();
    expect(() => cleanAppKey("pm2", "$(id)")).toThrow();
  });

  it("checks the pm2 user", () => {
    expect(cleanRunUser("")).toBe("");
    expect(cleanRunUser("deploy")).toBe("deploy");
    expect(() => cleanRunUser("a;b")).toThrow();
  });

  it("cuts a command name like the kernel does", () => {
    expect(cleanComm("a-very-long-process-name")).toHaveLength(15);
  });

  it("parses log targets", () => {
    expect(parseTarget({ kind: "journal", unit: "nginx.service" })).toEqual({
      kind: "journal",
      unit: "nginx.service",
    });
    expect(() => parseTarget({ kind: "journal", unit: "x y" })).toThrow();
    expect(() => parseTarget({ kind: "file", pid: 5, fd: -1 })).toThrow();
    expect(() => parseTarget({ kind: "other" })).toThrow();
  });
});

describe("scripts are valid shell", () => {
  const targets: LogTarget[] = [
    { kind: "journal", unit: "nginx.service" },
    { kind: "journal-pid", pid: 812 },
    { kind: "pm2", key: "api" },
    { kind: "supervisor", key: "web:web_00", stream: "stderr" },
    { kind: "file", pid: 812, fd: 4 },
  ];

  it("has no syntax errors", () => {
    const scripts = [
      STATUS_SCRIPT,
      LIST_SCRIPT,
      detailScript(812),
      signalScript(812, "TERM", "nginx"),
      signalScript(812, "KILL", ""),
      reniceScript(812, 5, "nginx"),
      managersScript(""),
      managersScript("deploy"),
      appActionScript("pm2", "api", "restart", ""),
      appActionScript("pm2", "api", "delete", "deploy"),
      appActionScript("supervisor", "web", "restart", ""),
      appActionScript("supervisor", "web", "flush", ""),
      ...targets.flatMap((target) => [
        logScript(target, { lines: 100, follow: false, runUser: "" }),
        logScript(target, {
          lines: 100,
          follow: false,
          grep: "it's an 'error'",
          runUser: "deploy",
        }),
        logScript(target, { lines: 50, follow: true, runUser: "" }),
      ]),
    ];
    for (const script of scripts) expect(syntaxOk(script), script).toBe(true);
  });
});

describe("script contents", () => {
  it("quotes the grep text", () => {
    const script = logScript(
      { kind: "journal", unit: "a.service" },
      { lines: 10, follow: false, grep: "x'; reboot; '", runUser: "" },
    );
    expect(script).toContain(`grep -a -i -F -e 'x'\\''; reboot; '\\'''`);
  });

  it("guards a signal against a reused pid", () => {
    const script = signalScript(812, "TERM", "nginx");
    expect(script).toContain("/proc/$pid/comm");
    expect(script).toContain("'nginx'");
  });

  it("does not splice names into pm2 commands", () => {
    const script = appActionScript("pm2", "api", "restart", "");
    expect(script).toBe("pm2 restart 'api' 2>&1\n");
  });

  it("runs pm2 as the chosen user", () => {
    const script = appActionScript("pm2", "api", "restart", "deploy");
    expect(script).toContain("sudo -n -u 'deploy' -H bash -lc");
  });

  it("only reads files the process writes", () => {
    const script = logScript(
      { kind: "file", pid: 812, fd: 4 },
      { lines: 10, follow: false, runUser: "" },
    );
    expect(script).toContain("fdinfo");
    expect(script).toContain("/dev/*|/proc/*|/sys/*");
  });

  it("follows with tail -F", () => {
    const script = logScript(
      { kind: "file", pid: 812, fd: 4 },
      { lines: 10, follow: true, runUser: "" },
    );
    expect(script).toContain("tail -n 10 -F");
  });
});
