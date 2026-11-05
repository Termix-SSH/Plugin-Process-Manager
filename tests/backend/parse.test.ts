import { describe, expect, it } from "vitest";
import {
  parseDetail,
  parsePm2,
  parseProcessList,
  parseStatus,
  parseSupervisor,
  sections,
  unitFromCgroup,
} from "../../src/backend/parse";

const PS = `@@cpus
4
@@load
0.52 0.40 0.31 1/300 999
@@zombies
1
@@ps
    1     0 root                  0.0  0.1  11000 Ss   0   1    5000 systemd /sbin/init splash
  812     1 www-data             12.5  2.3  64000 S    0   4     900 nginx nginx: worker process
  900   812 deploy                0.0  0.0      0 Z   -   1      30 sh [sh] <defunct>
garbage line
`;

describe("sections", () => {
  it("splits at marker lines", () => {
    expect(sections("@@a\none\ntwo\n@@b\nthree\n")).toEqual({
      a: "one\ntwo",
      b: "three",
    });
  });
});

describe("process list", () => {
  it("reads ps rows, load and zombies", () => {
    const list = parseProcessList(PS);
    expect(list.cpus).toBe(4);
    expect(list.load).toEqual([0.52, 0.4, 0.31]);
    expect(list.zombies).toBe(1);
    expect(list.processes).toHaveLength(3);
    expect(list.processes[1]).toMatchObject({
      pid: 812,
      ppid: 1,
      user: "www-data",
      cpu: 12.5,
      mem: 2.3,
      threads: 4,
      age: 900,
      command: "nginx",
      args: "nginx: worker process",
    });
    expect(list.processes[2].nice).toBeNull();
  });
});

describe("long command lines", () => {
  it("are cut so a list stays small", () => {
    const long = "-device ".repeat(500);
    const list = parseProcessList(
      `@@ps\n  7     1 root   1.0  1.0   100 S    0   1     5 qemu qemu ${long}\n`,
    );
    expect(list.processes[0].args.length).toBe(300);
  });
});

describe("process detail", () => {
  const out = `@@cmdline
/usr/sbin/nginx -g daemon off;
@@cwd
/
@@exe
/usr/sbin/nginx
@@cgroup
0::/system.slice/nginx.service
@@status
State:	S (sleeping)
Threads:	4
VmSize:	  100000 kB
VmRSS:	   2048 kB
@@env
PATH
HOME
@@fds
12
@@limits
Limit Soft Hard
@@ports
tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))
@@files
4|/var/log/nginx/access.log
5|/var/log/nginx/error.log
`;

  it("reads the facts", () => {
    const d = parseDetail(812, out);
    expect(d.unit).toBe("nginx.service");
    expect(d.rss).toBe(2048 * 1024);
    expect(d.threads).toBe(4);
    expect(d.envKeys).toEqual(["PATH", "HOME"]);
    expect(d.files).toEqual([
      { fd: 4, path: "/var/log/nginx/access.log" },
      { fd: 5, path: "/var/log/nginx/error.log" },
    ]);
    expect(d.ports).toHaveLength(1);
  });

  it("finds a service in a nested cgroup", () => {
    expect(
      unitFromCgroup("0::/user.slice/user-1000.slice/session-3.scope"),
    ).toBe("");
    expect(unitFromCgroup("0::/system.slice/ssh.service/x")).toBe(
      "ssh.service",
    );
  });
});

describe("status", () => {
  it("reads key value lines", () => {
    const s = parseStatus(
      "os=Debian\nuser=deploy\nroot=0\nps=1\npm2=1\nsupervisor=0\nsystemd=1\n",
      true,
      false,
    );
    expect(s).toMatchObject({
      os: "Debian",
      root: false,
      psOk: true,
      pm2: true,
      supervisor: false,
      systemd: true,
      canEdit: true,
    });
  });
});

describe("pm2", () => {
  const json = JSON.stringify([
    {
      name: "api",
      pm_id: 0,
      pid: 4321,
      monit: { memory: 52428800, cpu: 3 },
      pm2_env: {
        status: "online",
        restart_time: 2,
        pm_uptime: Date.now() - 90_000,
        pm_exec_path: "/srv/api/index.js",
      },
    },
    {
      name: "worker",
      pm_id: 1,
      pid: 0,
      monit: { memory: 0, cpu: 0 },
      pm2_env: { status: "errored", restart_time: 15 },
    },
  ]);

  it("skips notices before the JSON", () => {
    const apps = parsePm2(`[PM2] Spawning PM2 daemon\n${json}`);
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({
      manager: "pm2",
      key: "0",
      name: "api",
      health: "up",
      pid: 4321,
      restarts: 2,
    });
    expect(apps[0].uptime).toBeGreaterThanOrEqual(89);
    expect(apps[1]).toMatchObject({ health: "down", pid: null });
  });

  it("returns nothing for bad output", () => {
    expect(parsePm2("@@none")).toEqual([]);
    expect(parsePm2("[PM2] nothing here")).toEqual([]);
  });
});

describe("supervisor", () => {
  it("reads supervisorctl status", () => {
    const apps =
      parseSupervisor(`web:web_00    RUNNING   pid 812, uptime 1 day, 2:03:04
worker        FATAL     Exited too quickly (process log may have details)
queue         BACKOFF   Exited too quickly
cron          STOPPED   Nov 05 10:00 AM
`);
    expect(apps.map((a) => [a.key, a.health])).toEqual([
      ["web:web_00", "up"],
      ["worker", "down"],
      ["queue", "wait"],
      ["cron", "down"],
    ]);
    expect(apps[0].pid).toBe(812);
  });
});
