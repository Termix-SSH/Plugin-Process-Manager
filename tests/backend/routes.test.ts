import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./helpers";

let s: TestServer | null = null;

afterEach(async () => {
  await s?.close();
  s = null;
});

const LIST = `@@cpus
2
@@load
0.10 0.20 0.30 1/200 55
@@zombies
0
@@ps
  812     1 www-data             12.5  2.3  64000 S    0   4     900 nginx nginx: worker
  900     1 deploy                0.0  0.0   1000 S    0   1      30 node node app.js
`;

const MANAGERS = `@@pm2
[{"name":"api","pm_id":3,"pid":10,"monit":{"memory":1048576,"cpu":2},"pm2_env":{"status":"online","restart_time":1,"pm_uptime":1}}]
@@supervisor
web RUNNING pid 5, uptime 0:10:00
`;

describe("status", () => {
  it("reports what the host has", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "pm2=",
      stdout:
        "os=Debian\nuser=deploy\nroot=0\nps=1\npm2=1\nsupervisor=0\nsystemd=1\n",
    });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pm2: true, psOk: true, canEdit: true });
  });

  it("refuses a host with Process Manager off", async () => {
    s = await startServer({ hostSettings: { enableProcesses: false } });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("disabled");
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("refuses callers without the permission", async () => {
    s = await startServer({ permissions: [] });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(403);
  });
});

describe("processes", () => {
  it("lists them", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "@@cpus", stdout: LIST });
    const res = await s.request("GET", "/1/processes");
    expect(res.status).toBe(200);
    expect(res.body.processes).toHaveLength(2);
    expect(res.body.cpus).toBe(2);
  });

  it("reads detail for one pid", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "pid=812",
      stdout:
        "@@cmdline\nnginx -g daemon off;\n@@cgroup\n0::/system.slice/nginx.service\n",
    });
    const res = await s.request("GET", "/1/processes/812");
    expect(res.body.cmdline).toBe("nginx -g daemon off;");
    expect(res.body.unit).toBe("nginx.service");
  });

  it("rejects a bad pid", async () => {
    s = await startServer();
    const res = await s.request("GET", "/1/processes/1");
    expect(res.status).toBe(400);
    expect(s.ssh.calls).toHaveLength(0);
  });
});

describe("signals", () => {
  it("sends TERM with the command guard", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "kill -TERM", stdout: "Sent TERM to 812\n" });
    const res = await s.request("POST", "/1/processes/812/signal", {
      signal: "TERM",
      command: "nginx",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(s.ssh.calls[0].stdin).toContain("pid=812");
    expect(s.ssh.calls[0].stdin).toContain("'nginx'");
  });

  it("sends KILL through the kill action", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "kill -KILL", stdout: "Sent KILL to 812\n" });
    const res = await s.request("POST", "/1/processes/812/signal", {
      signal: "KILL",
    });
    expect(res.status).toBe(200);
  });

  it("refuses a signal that is not allowed", async () => {
    s = await startServer();
    const res = await s.request("POST", "/1/processes/812/signal", {
      signal: "ABRT",
    });
    expect(res.status).toBe(400);
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("needs edit access", async () => {
    s = await startServer({ level: "connect" });
    const res = await s.request("POST", "/1/processes/812/signal", {
      signal: "TERM",
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("HOST_EDIT_REQUIRED");
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("is refused on read only hosts", async () => {
    s = await startServer({ hostSettings: { readOnly: true } });
    const res = await s.request("POST", "/1/processes/812/signal", {
      signal: "TERM",
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("readOnly");
  });

  it("explains a reused pid", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "kill -TERM",
      stdout: "SCRIPT_ERR:That pid now belongs to another process\n",
      code: 1,
    });
    const res = await s.request("POST", "/1/processes/812/signal", {
      signal: "TERM",
      command: "nginx",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("another process");
  });

  it("changes the priority", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "renice -n 5", stdout: "ok\n" });
    const res = await s.request("POST", "/1/processes/812/renice", {
      nice: 5,
      command: "nginx",
    });
    expect(res.status).toBe(200);
  });
});

describe("apps", () => {
  it("lists pm2 and supervisor apps", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "@@pm2", stdout: MANAGERS });
    const res = await s.request("GET", "/1/apps");
    expect(res.body.pm2).toBe(true);
    expect(res.body.supervisor).toBe(true);
    expect(res.body.apps.map((a: { name: string }) => a.name)).toEqual([
      "api",
      "web",
    ]);
  });

  it("restarts a pm2 app as the login user", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "pm2 restart", stdout: "done\n" });
    const res = await s.request("POST", "/1/apps/pm2/api/restart", {});
    expect(res.status).toBe(200);
    expect(s.ssh.calls[0].stdin).toContain("pm2 restart 'api'");
    expect(s.ssh.calls[0].stdin).not.toContain("sudo -n -u");
  });

  it("runs pm2 as the chosen user", async () => {
    s = await startServer({ hostSettings: { pm2User: "deploy" } });
    s.ssh.replies.push({ match: "pm2 restart", stdout: "done\n" });
    await s.request("POST", "/1/apps/pm2/api/restart", {});
    expect(s.ssh.calls[0].stdin).toContain("sudo -n -u 'deploy' -H bash -lc");
  });

  it("reports a failed app action", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "supervisorctl stop",
      stdout: "ERROR (no such process)\n",
      code: 1,
    });
    const res = await s.request("POST", "/1/apps/supervisor/web/stop", {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no such process");
  });

  it("refuses names that could run commands", async () => {
    s = await startServer();
    const res = await s.request(
      "POST",
      "/1/apps/supervisor/x%3B%20reboot/stop",
      {},
    );
    expect(res.status).toBe(400);
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("refuses an unknown action", async () => {
    s = await startServer();
    const res = await s.request("POST", "/1/apps/pm2/api/explode", {});
    expect(res.status).toBe(400);
  });
});

describe("logs", () => {
  it("reads a service journal", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "journalctl -u",
      stdout: "line one\nline two\n",
    });
    const res = await s.request("POST", "/1/logs", {
      target: { kind: "journal", unit: "nginx.service" },
      lines: 50,
    });
    expect(res.body).toEqual({ text: "line one\nline two\n", lines: 3 });
    expect(s.ssh.calls[0].stdin).toContain("-n 50");
  });

  it("needs edit access to read an open file", async () => {
    s = await startServer({ level: "connect" });
    const res = await s.request("POST", "/1/logs", {
      target: { kind: "file", pid: 812, fd: 4 },
    });
    expect(res.status).toBe(403);
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("reads an open file with edit access", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "fdinfo", stdout: "hello\n" });
    const res = await s.request("POST", "/1/logs", {
      target: { kind: "file", pid: 812, fd: 4 },
    });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("hello\n");
  });

  it("rejects a bad source", async () => {
    s = await startServer();
    const res = await s.request("POST", "/1/logs", { target: { kind: "x" } });
    expect(res.status).toBe(400);
  });
});

describe("watches", () => {
  it("adds, lists and removes watches per user", async () => {
    s = await startServer();
    const added = await s.request("POST", "/1/watches", {
      kind: "process",
      target: "nginx",
      rule: "down",
    });
    expect(added.status).toBe(200);
    expect(added.body.watches).toHaveLength(1);
    const id = added.body.watches[0].id;

    s.mock.setActor("user-2");
    expect((await s.request("GET", "/1/watches")).body.watches).toEqual([]);

    s.mock.setActor("user-1");
    const removed = await s.request("DELETE", `/1/watches/${id}`);
    expect(removed.body.watches).toEqual([]);
  });

  it("refuses a duplicate and a bad rule", async () => {
    s = await startServer();
    const body = { kind: "pm2", target: "api", rule: "down" };
    await s.request("POST", "/1/watches", body);
    expect((await s.request("POST", "/1/watches", body)).status).toBe(400);
    expect(
      (
        await s.request("POST", "/1/watches", {
          kind: "supervisor",
          target: "web",
          rule: "restarts",
          threshold: 3,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await s.request("POST", "/1/watches", {
          kind: "process",
          target: "x",
          rule: "cpu",
        })
      ).status,
    ).toBe(400);
  });

  it("lists every watch with its state", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "@@cpus", stdout: LIST });
    await s.request("POST", "/1/watches", {
      kind: "process",
      target: "nginx",
      rule: "down",
    });
    await s.mock.runScheduled();
    const res = await s.request("GET", "/watches");
    expect(res.body.watches[0]).toMatchObject({
      hostId: 1,
      target: "nginx",
      state: "up",
    });
  });
});

describe("watch alerts", () => {
  it("alerts once when a process goes down and once when it is back", async () => {
    s = await startServer();
    const reply = { match: "@@cpus", stdout: LIST };
    s.ssh.replies.push(reply);
    await s.request("POST", "/1/watches", {
      kind: "process",
      target: "nginx",
      rule: "down",
    });

    await s.mock.runScheduled();
    expect(s.mock.notifications).toHaveLength(0);

    reply.stdout = LIST.replace(/ {2}812.*\n/, "");
    await s.mock.runScheduled();
    await s.mock.runScheduled();
    expect(s.mock.notifications).toHaveLength(1);
    expect(s.mock.notifications[0].notification).toMatchObject({
      severity: "critical",
      category: "process-manager.process_down",
      audience: { userId: "user-1" },
    });
    expect(s.mock.operationEvents[0]?.eventId).toBe(
      "process-manager.process-down",
    );

    reply.stdout = LIST;
    await s.mock.runScheduled();
    expect(s.mock.notifications).toHaveLength(2);
    expect(s.mock.notifications[1].notification.category).toBe(
      "process-manager.process_recovered",
    );
  });

  it("restarts a downed app by itself, at most three times an hour", async () => {
    s = await startServer();
    const down = `@@pm2
[{"name":"api","pm_id":3,"pid":0,"monit":{"memory":0,"cpu":0},"pm2_env":{"status":"errored","restart_time":1}}]
@@supervisor
`;
    const up = down.replace("errored", "online");
    const reply = { match: "@@pm2", stdout: up };
    s.ssh.replies.push({ match: "pm2 restart", stdout: "ok\n" }, reply);
    await s.request("POST", "/1/watches", {
      kind: "pm2",
      target: "api",
      rule: "down",
      autoRestart: true,
    });
    await s.mock.runScheduled();
    reply.stdout = down;
    await s.mock.runScheduled();
    expect(
      s.ssh.calls.filter((c) => c.stdin.includes("pm2 restart")),
    ).toHaveLength(1);
    expect(s.mock.notifications[0].notification.body).toContain(
      "Restarted automatically",
    );
  });

  it("skips hosts the watcher lost access to", async () => {
    s = await startServer();
    await s.request("POST", "/1/watches", {
      kind: "process",
      target: "nginx",
      rule: "down",
    });
    Object.assign(s.mock.ctx.hosts, {
      checkAccess: async () => ({
        hasAccess: false,
        isOwner: false,
        isShared: false,
      }),
    });
    await s.mock.runScheduled();
    expect(s.ssh.calls.some((c) => c.stdin.includes("@@cpus"))).toBe(false);
  });
});
