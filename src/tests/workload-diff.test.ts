/**
 * Unit tests for k8s_workload_diff pure helpers.
 *
 * The async fetchWorkload / compareHpas / comparePdbs functions are
 * exercised through the MCP smoke test rather than mocked here. These
 * tests cover the deterministic diff logic.
 */

import { describe, it, expect } from "@jest/globals";
import {
  diffWorkloads,
  diffReplicas,
  diffContainers,
  diffContainerPair,
  diffEnvVars,
  collectEnvFromRefs,
  diffScheduling,
  diffMeta,
  filterKeys,
  diffMaps,
  selectorCovers,
} from "../k8s-tools/workload-diff.js";

const noIgnore = {
  includeHpa: true,
  includePdb: true,
  ignoreLabels: new Set<string>(),
  ignoreAnnotations: new Set<string>(),
  ignoreEnvVars: new Set<string>(),
};

describe("diffReplicas", () => {
  it("returns no findings when replicas match", () => {
    const a = { spec: { replicas: 3 } };
    const b = { spec: { replicas: 3 } };
    expect(diffReplicas(a, b, "Deployment")).toHaveLength(0);
  });

  it("flags warning when replicas differ", () => {
    const a = { spec: { replicas: 3 } };
    const b = { spec: { replicas: 5 } };
    const result = diffReplicas(a, b, "Deployment");
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("warning");
    expect(result[0].message).toMatch(/source=3, target=5/);
  });

  it("treats missing replicas as 0", () => {
    const a = {};
    const b = { spec: { replicas: 5 } };
    const result = diffReplicas(a, b, "Deployment");
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("0");
    expect(result[0].target).toBe("5");
  });

  it("skips DaemonSets entirely", () => {
    const a = { spec: { replicas: 3 } };
    const b = { spec: { replicas: 5 } };
    expect(diffReplicas(a, b, "DaemonSet")).toHaveLength(0);
  });
});

describe("diffContainerPair", () => {
  it("flags critical when image differs", () => {
    const a = { name: "web", image: "nginx:1.19" };
    const b = { name: "web", image: "nginx:1.20" };
    const result = diffContainerPair(a, b, noIgnore);
    const imageFinding = result.find((f) => f.category === "Image");
    expect(imageFinding).toBeDefined();
    expect(imageFinding!.severity).toBe("critical");
  });

  it("no findings when containers are identical", () => {
    const a = { name: "web", image: "nginx:1.19" };
    const b = { name: "web", image: "nginx:1.19" };
    expect(diffContainerPair(a, b, noIgnore)).toHaveLength(0);
  });

  it("flags CPU request difference as warning", () => {
    const a = {
      name: "web",
      image: "nginx",
      resources: { requests: { cpu: "100m" } },
    };
    const b = {
      name: "web",
      image: "nginx",
      resources: { requests: { cpu: "500m" } },
    };
    const result = diffContainerPair(a, b, noIgnore);
    expect(result.some((f) => f.category === "CPU request")).toBe(true);
    expect(
      result.find((f) => f.category === "CPU request")?.severity,
    ).toBe("warning");
  });

  it("flags memory limit difference as warning", () => {
    const a = {
      name: "web",
      image: "nginx",
      resources: { limits: { memory: "512Mi" } },
    };
    const b = {
      name: "web",
      image: "nginx",
      resources: { limits: { memory: "2Gi" } },
    };
    const result = diffContainerPair(a, b, noIgnore);
    expect(result.some((f) => f.category === "Memory limit")).toBe(true);
  });

  it("flags env var differences as info", () => {
    const a = {
      name: "web",
      image: "nginx",
      env: [{ name: "ENV", value: "staging" }],
    };
    const b = {
      name: "web",
      image: "nginx",
      env: [{ name: "ENV", value: "prod" }],
    };
    const result = diffContainerPair(a, b, noIgnore);
    const envFinding = result.find(
      (f) => f.category === "Environment variables",
    );
    expect(envFinding).toBeDefined();
    expect(envFinding!.severity).toBe("info");
  });

  it("flags ConfigMap reference present-on-source-only", () => {
    const a = {
      name: "web",
      image: "nginx",
      envFrom: [{ configMapRef: { name: "app-config" } }],
    };
    const b = { name: "web", image: "nginx", envFrom: [] };
    const result = diffContainerPair(a, b, noIgnore);
    expect(
      result.some((f) =>
        f.message.includes("present in source but missing in target"),
      ),
    ).toBe(true);
  });
});

describe("diffContainers", () => {
  it("flags critical when container count differs", () => {
    const a = {
      spec: {
        template: { spec: { containers: [{ name: "a", image: "x" }] } },
      },
    };
    const b = {
      spec: {
        template: {
          spec: {
            containers: [
              { name: "a", image: "x" },
              { name: "b", image: "y" },
            ],
          },
        },
      },
    };
    const result = diffContainers(a, b, noIgnore);
    expect(result[0].category).toBe("Container count");
    expect(result[0].severity).toBe("critical");
    // Should not attempt further alignment
    expect(result).toHaveLength(1);
  });

  it("matches containers by name when possible", () => {
    const a = {
      spec: {
        template: {
          spec: {
            containers: [
              { name: "web", image: "nginx:1.19" },
              { name: "sidecar", image: "envoy:1.20" },
            ],
          },
        },
      },
    };
    const b = {
      spec: {
        template: {
          spec: {
            containers: [
              { name: "sidecar", image: "envoy:1.20" }, // reordered
              { name: "web", image: "nginx:1.19" },
            ],
          },
        },
      },
    };
    const result = diffContainers(a, b, noIgnore);
    expect(result).toHaveLength(0); // matched by name, no diffs
  });
});

describe("diffEnvVars", () => {
  it("returns names of vars present in source but not target", () => {
    const a = [{ name: "FOO", value: "1" }];
    const b: Array<{ name?: string; value?: string }> = [];
    expect(diffEnvVars(a, b, new Set())).toEqual(["FOO"]);
  });

  it("returns names of vars with different values", () => {
    const a = [{ name: "ENV", value: "staging" }];
    const b = [{ name: "ENV", value: "prod" }];
    expect(diffEnvVars(a, b, new Set())).toEqual(["ENV"]);
  });

  it("returns empty when all vars match", () => {
    const a = [
      { name: "FOO", value: "1" },
      { name: "BAR", value: "2" },
    ];
    const b = [
      { name: "BAR", value: "2" },
      { name: "FOO", value: "1" },
    ];
    expect(diffEnvVars(a, b, new Set())).toEqual([]);
  });

  it("respects the ignored set", () => {
    const a = [{ name: "ENV", value: "staging" }];
    const b = [{ name: "ENV", value: "prod" }];
    expect(diffEnvVars(a, b, new Set(["ENV"]))).toEqual([]);
  });

  it("dedupes when same name is on both sides with diff value", () => {
    const a = [{ name: "X", value: "a" }];
    const b = [{ name: "X", value: "b" }];
    expect(diffEnvVars(a, b, new Set())).toEqual(["X"]);
  });
});

describe("collectEnvFromRefs", () => {
  it("returns empty for empty input", () => {
    expect(collectEnvFromRefs([]).size).toBe(0);
  });

  it("collects ConfigMap refs", () => {
    const refs = collectEnvFromRefs([
      { configMapRef: { name: "app-config" } },
    ]);
    expect(refs.has("ConfigMap/app-config")).toBe(true);
  });

  it("collects Secret refs", () => {
    const refs = collectEnvFromRefs([{ secretRef: { name: "app-secret" } }]);
    expect(refs.has("Secret/app-secret")).toBe(true);
  });

  it("handles mixed ConfigMap+Secret entries", () => {
    const refs = collectEnvFromRefs([
      { configMapRef: { name: "cm1" } },
      { secretRef: { name: "s1" } },
    ]);
    expect(refs.size).toBe(2);
  });
});

describe("diffScheduling", () => {
  it("flags NodeSelector difference", () => {
    const a = {
      spec: {
        template: {
          spec: { nodeSelector: { "disk": "ssd" } },
        },
      },
    };
    const b = {
      spec: {
        template: {
          spec: { nodeSelector: { "disk": "hdd" } },
        },
      },
    };
    const result = diffScheduling(a, b);
    expect(result.some((f) => f.category === "NodeSelector")).toBe(true);
  });

  it("flags ServiceAccount difference", () => {
    const a = {
      spec: { template: { spec: { serviceAccountName: "default" } } },
    };
    const b = {
      spec: { template: { spec: { serviceAccountName: "privileged" } } },
    };
    const result = diffScheduling(a, b);
    expect(result.some((f) => f.category === "ServiceAccount")).toBe(true);
  });

  it("flags toleration count difference", () => {
    const a = {
      spec: {
        template: {
          spec: { tolerations: [{ key: "spot", effect: "NoSchedule" }] },
        },
      },
    };
    const b = { spec: { template: { spec: { tolerations: [] } } } };
    const result = diffScheduling(a, b);
    expect(result.some((f) => f.category === "Tolerations")).toBe(true);
  });

  it("no findings when scheduling identical", () => {
    const a = { spec: { template: { spec: { serviceAccountName: "x" } } } };
    const b = { spec: { template: { spec: { serviceAccountName: "x" } } } };
    expect(diffScheduling(a, b)).toHaveLength(0);
  });
});

describe("diffMeta", () => {
  it("flags label differences as info", () => {
    const a = { metadata: { labels: { app: "web", env: "staging" } } };
    const b = { metadata: { labels: { app: "web", env: "prod" } } };
    const result = diffMeta(a, b, noIgnore);
    const labels = result.find((f) => f.category === "Labels");
    expect(labels).toBeDefined();
    expect(labels!.severity).toBe("info");
  });

  it("respects ignoredLabels set", () => {
    const a = { metadata: { labels: { app: "web", env: "staging" } } };
    const b = { metadata: { labels: { app: "web", env: "prod" } } };
    const result = diffMeta(a, b, {
      ...noIgnore,
      ignoreLabels: new Set(["env"]),
    });
    expect(result).toHaveLength(0);
  });

  it("flags annotation differences as info", () => {
    const a = { metadata: { annotations: { "kubectl.kubernetes.io/last-applied": "v1" } } };
    const b = { metadata: { annotations: { "kubectl.kubernetes.io/last-applied": "v2" } } };
    const result = diffMeta(a, b, noIgnore);
    expect(result.some((f) => f.category === "Annotations")).toBe(true);
  });
});

describe("filterKeys", () => {
  it("removes ignored keys", () => {
    const m = { app: "web", env: "staging", tier: "frontend" };
    const result = filterKeys(m, new Set(["env"]));
    expect(result).toEqual({ app: "web", tier: "frontend" });
  });

  it("returns empty for empty input", () => {
    expect(filterKeys({}, new Set())).toEqual({});
  });

  it("returns input unchanged when ignored set is empty", () => {
    const m = { app: "web" };
    expect(filterKeys(m, new Set())).toEqual(m);
  });
});

describe("diffMaps", () => {
  it("returns differing keys", () => {
    expect(
      diffMaps({ a: "1", b: "2" }, { a: "1", b: "3" }),
    ).toEqual(["b"]);
  });

  it("returns keys present on one side only", () => {
    expect(diffMaps({ a: "1" }, { a: "1", b: "2" })).toEqual(["b"]);
  });

  it("returns empty when maps match", () => {
    expect(diffMaps({ a: "1" }, { a: "1" })).toEqual([]);
  });

  it("dedupes diffs", () => {
    expect(
      diffMaps({ a: "1", b: "2" }, { a: "X", b: "Y" }).sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("selectorCovers", () => {
  it("returns true when all selector keys match labels", () => {
    expect(
      selectorCovers({ app: "web", env: "prod" }, { app: "web" }),
    ).toBe(true);
  });

  it("returns false when any selector key mismatches", () => {
    expect(
      selectorCovers({ app: "web" }, { app: "web", env: "prod" }),
    ).toBe(false);
  });

  it("returns false for empty selector (won't match anything)", () => {
    expect(selectorCovers({ app: "web" }, {})).toBe(false);
  });
});

describe("diffWorkloads (integration of pure helpers)", () => {
  it("returns no findings for identical workloads", () => {
    const w = {
      metadata: { labels: { app: "web" } },
      spec: {
        replicas: 3,
        template: {
          spec: { containers: [{ name: "web", image: "nginx:1.19" }] },
        },
      },
    };
    expect(diffWorkloads(w, w, "Deployment", noIgnore)).toHaveLength(0);
  });

  it("returns combined findings across all categories", () => {
    const a = {
      metadata: { labels: { app: "web", env: "staging" } },
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: [
              {
                name: "web",
                image: "nginx:1.19",
                resources: { requests: { cpu: "100m" } },
                env: [{ name: "ENV", value: "staging" }],
              },
            ],
          },
        },
      },
    };
    const b = {
      metadata: { labels: { app: "web", env: "prod" } },
      spec: {
        replicas: 10,
        template: {
          spec: {
            containers: [
              {
                name: "web",
                image: "nginx:1.20",
                resources: { requests: { cpu: "500m" } },
                env: [{ name: "ENV", value: "prod" }],
              },
            ],
          },
        },
      },
    };
    const result = diffWorkloads(a, b, "Deployment", noIgnore);
    const categories = result.map((f) => f.category);
    expect(categories).toContain("Image");
    expect(categories).toContain("Replicas");
    expect(categories).toContain("CPU request");
    expect(categories).toContain("Environment variables");
    expect(categories).toContain("Labels");
  });

  it("severity rollup: critical for image, warning for replicas, info for labels", () => {
    const a = {
      metadata: { labels: { app: "web" } },
      spec: {
        replicas: 2,
        template: {
          spec: { containers: [{ name: "web", image: "nginx:1.19" }] },
        },
      },
    };
    const b = {
      metadata: { labels: { app: "web2" } },
      spec: {
        replicas: 5,
        template: {
          spec: { containers: [{ name: "web", image: "nginx:1.20" }] },
        },
      },
    };
    const result = diffWorkloads(a, b, "Deployment", noIgnore);
    const image = result.find((f) => f.category === "Image");
    const replicas = result.find((f) => f.category === "Replicas");
    const labels = result.find((f) => f.category === "Labels");
    expect(image!.severity).toBe("critical");
    expect(replicas!.severity).toBe("warning");
    expect(labels!.severity).toBe("info");
  });
});
