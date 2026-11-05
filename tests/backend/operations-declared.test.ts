import { describe, expect, it } from "vitest";
import { parseManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json";
import { registerOperations } from "../../src/backend/operations.js";

type Operations = {
  actions: Array<{
    id: string;
    risk: string;
    hostAccess?: string;
    scope: string;
    resource?: string;
    titleKey: string;
  }>;
  resources: Array<{ id: string; list: string }>;
  signals: Array<{ id: string; read: string }>;
};

const operations = (manifest.contributes as { operations: Operations })
  .operations;

describe("declared actions", () => {
  it("is a valid manifest", () => {
    expect(parseManifest(manifest).errors ?? []).toEqual([]);
  });

  it("has a handler for every declared action and nothing else", () => {
    const registered: string[] = [];
    const ctx = {
      operations: {
        register: (id: string) => {
          registered.push(id);
        },
      },
    } as unknown as PluginContext;
    (registerOperations as (...args: unknown[]) => void)(ctx, {}, {});
    expect([...registered].sort()).toEqual(
      operations.actions.map((action) => action.id).sort(),
    );
  });

  it("needs edit for anything that changes a host", () => {
    for (const action of operations.actions) {
      if (action.risk !== "read" && action.id.includes("-watch")) continue;
      if (action.risk !== "read") {
        expect(["edit", "manage"]).toContain(action.hostAccess);
      }
    }
  });

  it("points resources and signals at read actions", () => {
    const reads = new Set(
      operations.actions.filter((a) => a.risk === "read").map((a) => a.id),
    );
    for (const resource of operations.resources) {
      expect(reads.has(resource.list)).toBe(true);
    }
    for (const signal of operations.signals) {
      expect(reads.has(signal.read)).toBe(true);
    }
  });

  it("keeps destructive actions confirmed", () => {
    const destructive = operations.actions
      .filter((a) => a.risk === "destructive")
      .map((a) => a.id)
      .sort();
    expect(destructive).toEqual([
      "process-manager.app-delete",
      "process-manager.kill-process",
    ]);
  });
});
