import { describe, expect, it } from "vitest";
import type { AppRow, ProcessRow } from "../../src/shared/types";
import { cleanWatch, judge, type WatchRow } from "../../src/backend/watches";

const proc = (over: Partial<ProcessRow>): ProcessRow => ({
  pid: 5,
  ppid: 1,
  user: "root",
  cpu: 0,
  mem: 0,
  rss: 0,
  stat: "S",
  nice: 0,
  threads: 1,
  age: 10,
  command: "nginx",
  args: "nginx: master",
  ...over,
});

const app = (over: Partial<AppRow>): AppRow => ({
  manager: "pm2",
  key: "3",
  name: "api",
  status: "online",
  health: "up",
  pid: 1,
  cpu: 1,
  mem: 100 * 1048576,
  restarts: 0,
  uptime: 1,
  detail: "",
  ...over,
});

const watch = (over: Partial<WatchRow>): WatchRow => ({
  id: 1,
  userId: "u",
  hostId: 1,
  kind: "process",
  target: "nginx",
  rule: "down",
  threshold: 0,
  autoRestart: false,
  ...over,
});

describe("judge a process", () => {
  it("is down with no match and fine with one", () => {
    expect(judge(watch({}), { processes: [], apps: [] }, []).bad).toBe(true);
    expect(judge(watch({}), { processes: [proc({})], apps: [] }, []).bad).toBe(
      false,
    );
  });

  it("matches on the command line too", () => {
    const r = {
      processes: [proc({ command: "node", args: "node /srv/api.js" })],
      apps: [],
    };
    expect(judge(watch({ target: "api.js" }), r, []).bad).toBe(false);
  });

  it("adds up cpu of all matches", () => {
    const r = {
      processes: [proc({ cpu: 40 }), proc({ pid: 6, cpu: 50 })],
      apps: [],
    };
    expect(judge(watch({ rule: "cpu", threshold: 80 }), r, []).bad).toBe(true);
    expect(judge(watch({ rule: "cpu", threshold: 95 }), r, []).bad).toBe(false);
  });
});

describe("judge an app", () => {
  it("is down when errored and unknown while starting", () => {
    const w = watch({ kind: "pm2", target: "api" });
    expect(
      judge(
        w,
        { processes: [], apps: [app({ health: "down", status: "errored" })] },
        [],
      ).bad,
    ).toBe(true);
    expect(
      judge(w, { processes: [], apps: [app({ health: "wait" })] }, []).bad,
    ).toBeNull();
    expect(judge(w, { processes: [], apps: [app({})] }, []).bad).toBe(false);
  });

  it("is down when the app vanished", () => {
    expect(
      judge(
        watch({ kind: "pm2", target: "api" }),
        { processes: [], apps: [] },
        [],
      ).bad,
    ).toBe(true);
  });

  it("counts restarts in the window", () => {
    const w = watch({
      kind: "pm2",
      target: "api",
      rule: "restarts",
      threshold: 3,
    });
    const r = { processes: [], apps: [app({ restarts: 7 })] };
    expect(judge(w, r, [4, 5, 7]).bad).toBe(true);
    expect(judge(w, r, [6, 7]).bad).toBe(false);
  });

  it("reads memory in MB", () => {
    const w = watch({ kind: "pm2", target: "api", rule: "mem", threshold: 50 });
    expect(judge(w, { processes: [], apps: [app({})] }, []).bad).toBe(true);
  });
});

describe("clean a watch", () => {
  it("fills defaults", () => {
    expect(cleanWatch({ kind: "pm2", target: " api " })).toEqual({
      kind: "pm2",
      target: "api",
      rule: "down",
      threshold: 0,
      autoRestart: false,
    });
  });

  it("only restarts apps that went down", () => {
    expect(
      cleanWatch({ kind: "process", target: "x", autoRestart: true })
        .autoRestart,
    ).toBe(false);
    expect(
      cleanWatch({ kind: "pm2", target: "x", autoRestart: true }).autoRestart,
    ).toBe(true);
    expect(
      cleanWatch({
        kind: "pm2",
        target: "x",
        rule: "cpu",
        threshold: 50,
        autoRestart: true,
      }).autoRestart,
    ).toBe(false);
  });

  it("rejects bad input", () => {
    expect(() => cleanWatch({ kind: "x", target: "a" })).toThrow();
    expect(() => cleanWatch({ kind: "pm2", target: "" })).toThrow();
    expect(() =>
      cleanWatch({ kind: "pm2", target: "a", rule: "cpu" }),
    ).toThrow();
    expect(() =>
      cleanWatch({
        kind: "process",
        target: "a",
        rule: "restarts",
        threshold: 2,
      }),
    ).toThrow();
  });
});
