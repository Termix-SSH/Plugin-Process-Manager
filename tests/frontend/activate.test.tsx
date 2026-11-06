import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";
import { filterRows, sortRows, treeRows } from "../../src/frontend/format";
import type { ProcessRow } from "../../src/shared/types";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const status = {
  os: "Debian GNU/Linux 13",
  user: "deploy",
  root: true,
  psOk: true,
  pm2: true,
  supervisor: false,
  systemd: true,
  canEdit: true,
  readOnly: false,
};

const row = (over: Partial<ProcessRow>): ProcessRow => ({
  pid: 100,
  ppid: 1,
  user: "root",
  cpu: 1,
  mem: 1,
  rss: 1000,
  stat: "S",
  nice: 0,
  threads: 1,
  age: 60,
  command: "sshd",
  args: "sshd: /usr/sbin/sshd",
  ...over,
});

const processes = {
  processes: [
    row({ pid: 812, command: "nginx", args: "nginx: master", cpu: 12.5 }),
    row({ pid: 900, ppid: 812, command: "nginx", args: "nginx: worker" }),
    row({ pid: 950, command: "zed", args: "[zed] <defunct>", stat: "Z" }),
  ],
  cpus: 2,
  load: [0.1, 0.2, 0.3],
  zombies: 1,
};

const apps = {
  pm2: true,
  supervisor: false,
  apps: [
    {
      manager: "pm2",
      key: "3",
      name: "api",
      status: "online",
      health: "up",
      pid: 10,
      cpu: 2,
      mem: 1048576,
      restarts: 1,
      uptime: 90,
      detail: "",
    },
  ],
};

const detail = {
  pid: 812,
  cmdline: "nginx: master process",
  cwd: "/",
  exe: "/usr/sbin/nginx",
  unit: "nginx.service",
  state: "S (sleeping)",
  threads: 4,
  rss: 2048,
  vsize: 4096,
  envKeys: ["PATH"],
  fdCount: 12,
  limits: [],
  ports: [],
  files: [{ fd: 4, path: "/var/log/nginx/access.log" }],
};

function api() {
  return {
    get: vi.fn(async (url: string) => ({
      data: url.endsWith("/status")
        ? status
        : url.endsWith("/processes")
          ? processes
          : /\/processes\/\d+$/.test(url)
            ? detail
            : url.endsWith("/apps")
              ? apps
              : url.includes("/watches")
                ? { watches: [], max: 50 }
                : {},
    })),
    post: vi.fn(async () => ({ data: { ok: true, output: "" } })),
  } as never;
}

const host = {
  id: 1,
  name: "web",
  enableSsh: true,
  pluginSettings: { "process-manager": { enableProcesses: true } },
};

describe(`${manifest.id} activate`, () => {
  it("registers the host tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["process-manager"]);
  });

  it("fills the Host Metrics card and the host page tile", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.slot("host-metrics.managers")).toContain(
      "process_inspector",
    );
    expect(rendered.registered.slot("host-page.tiles")).toContain(
      "process-manager.hostTile",
    );
    expect(rendered.registered.dashboardCards()).toContain("process-watches");
  });

  it("lists processes with their numbers", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(),
    });
    rendered.renderTab("process-manager", { isVisible: true, host });
    expect((await screen.findAllByText("nginx")).length).toBeGreaterThan(0);
    expect(screen.getByText(locales.list.zombies)).toBeTruthy();
    expect(screen.getByText(locales.state.zombie)).toBeTruthy();
  });

  it("opens the detail of a process", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(),
    });
    rendered.renderTab("process-manager", { isVisible: true, host });
    fireEvent.click((await screen.findAllByText("nginx"))[0]);
    expect(await screen.findByText("TERM")).toBeTruthy();
    expect(screen.getByText("SIGKILL".replace("SIG", ""))).toBeTruthy();
  });

  it("shows the apps", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(),
    });
    rendered.renderTab("process-manager", { isVisible: true, host });
    fireEvent.click(await screen.findByText(locales.tab.viewApps));
    expect(await screen.findByText("api")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
  });

  it("shows an error when the host cannot be read", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => {
          throw new Error("offline");
        }),
      } as never,
    });
    rendered.renderTab("process-manager", { isVisible: true, host });
    expect(await screen.findByText(locales.tab.error)).toBeTruthy();
  });
});

describe("process helpers", () => {
  const rows = processes.processes;

  it("sorts by cpu and pid", () => {
    expect(sortRows(rows, "cpu")[0].pid).toBe(812);
    expect(sortRows(rows, "pid").map((p) => p.pid)).toEqual([812, 900, 950]);
  });

  it("filters by name, args, user or exact pid", () => {
    expect(filterRows(rows, "worker")).toHaveLength(1);
    expect(filterRows(rows, "900")).toHaveLength(1);
    expect(filterRows(rows, "")).toHaveLength(3);
  });

  it("orders a tree and survives cycles", () => {
    const tree = treeRows(rows);
    expect(tree.map((n) => [n.proc.pid, n.depth])).toEqual([
      [812, 0],
      [900, 1],
      [950, 0],
    ]);
    const loop = [row({ pid: 5, ppid: 6 }), row({ pid: 6, ppid: 5 })];
    expect(treeRows(loop).length).toBeLessThanOrEqual(2);
  });
});

describe("homepage widget", () => {
  it("adds a homepage widget and declares the extension point", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.extensions("homepage.widgets")).toEqual([
      "process_manager_widget",
    ]);
    expect(manifest.contributes.uses).toContain("homepage.widgets");
  });
});
