import * as k8s from "@kubernetes/client-node";
import { K8sClient } from "../k8s-client.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyError, ErrorContext } from "../error-handling.js";

/**
 * Registers the k8s_workload_diff SRE tool.
 *
 * Compares two workloads (Deployment, StatefulSet, or DaemonSet) and returns
 * a categorized structured diff: image, replicas, resources, env vars,
 * ConfigMap/Secret refs, labels, scheduling, HPA, PDB.
 *
 * Returns severity classification per finding:
 *   - critical: image mismatch, container count mismatch, target missing
 *   - warning:  resource drift, replica drift, scheduling drift, PDB gap
 *   - info:     label/annotation/env-var differences (often intentional)
 *
 * Read-only. Safe under all protection modes.
 */
export function registerWorkloadDiffTools(
  k8sClient: K8sClient,
): { tool: Tool; handler: Function }[] {
  return [
    {
      tool: {
        name: "k8s_workload_diff",
        description:
          "Compares two workloads (same kind, e.g. staging vs prod Deployment) and returns a categorized diff: image tags, replicas, resource requests/limits, env vars, ConfigMap/Secret refs, labels, scheduling, HPA settings, PDB coverage. Returns severity per finding (critical/warning/info) and a verdict (in_sync, drift_detected, comparison_failed). Use to answer 'how is staging different from prod' or 'what changed between blue and green'. Read-only and safe under all protection modes.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "object",
              description:
                "Source workload (one side of the comparison).",
              properties: {
                kind: {
                  type: "string",
                  enum: ["Deployment", "StatefulSet", "DaemonSet"],
                },
                name: { type: "string" },
                namespace: { type: "string", default: "default" },
              },
              required: ["kind", "name"],
            },
            target: {
              type: "object",
              description:
                "Target workload (the other side of the comparison). Must be the same kind as source.",
              properties: {
                kind: {
                  type: "string",
                  enum: ["Deployment", "StatefulSet", "DaemonSet"],
                },
                name: { type: "string" },
                namespace: { type: "string", default: "default" },
              },
              required: ["kind", "name"],
            },
            includeHpa: {
              type: "boolean",
              description:
                "Include HorizontalPodAutoscaler comparison. Defaults to true.",
              default: true,
            },
            includePdb: {
              type: "boolean",
              description:
                "Include PodDisruptionBudget coverage comparison. Defaults to true.",
              default: true,
            },
            ignoreLabels: {
              type: "array",
              items: { type: "string" },
              description:
                "Label keys to ignore in the comparison (e.g. 'env', 'tier'). Useful when intentional differences would otherwise be reported as drift.",
            },
            ignoreAnnotations: {
              type: "array",
              items: { type: "string" },
              description:
                "Annotation keys to ignore in the comparison.",
            },
            ignoreEnvVars: {
              type: "array",
              items: { type: "string" },
              description:
                "Environment variable names to ignore in the comparison.",
            },
          },
          required: ["source", "target"],
        },
      },
      handler: async (args: WorkloadDiffArgs) => {
        const startedAt = Date.now();
        if (args.source.kind !== args.target.kind) {
          return errorResult(
            args,
            `kind mismatch: source=${args.source.kind} vs target=${args.target.kind}; both sides must be the same kind`,
            startedAt,
          );
        }

        try {
          const [sourceWorkload, targetWorkload] = await Promise.all([
            fetchWorkload(k8sClient, args.source),
            fetchWorkload(k8sClient, args.target),
          ]);

          if (!sourceWorkload) {
            return errorResult(
              args,
              `source ${args.source.kind} ${args.source.namespace ?? "default"}/${args.source.name} not found`,
              startedAt,
            );
          }
          if (!targetWorkload) {
            return errorResult(
              args,
              `target ${args.target.kind} ${args.target.namespace ?? "default"}/${args.target.name} not found`,
              startedAt,
            );
          }

          const opts = {
            includeHpa: args.includeHpa ?? true,
            includePdb: args.includePdb ?? true,
            ignoreLabels: new Set(args.ignoreLabels ?? []),
            ignoreAnnotations: new Set(args.ignoreAnnotations ?? []),
            ignoreEnvVars: new Set(args.ignoreEnvVars ?? []),
          };

          const findings = diffWorkloads(
            sourceWorkload,
            targetWorkload,
            args.source.kind,
            opts,
          );

          // Optionally enrich with HPA and PDB comparisons (network calls).
          const extras = await Promise.all([
            opts.includeHpa
              ? compareHpas(k8sClient, args)
              : Promise.resolve<Finding[]>([]),
            opts.includePdb
              ? comparePdbs(k8sClient, args, sourceWorkload, targetWorkload)
              : Promise.resolve<Finding[]>([]),
          ]);
          for (const list of extras) findings.push(...list);

          return assemble(args, findings, startedAt);
        } catch (err) {
          const ctx: ErrorContext = {
            operation: "k8s_workload_diff",
            resource: `${args.source.name} vs ${args.target.name}`,
            namespace: args.source.namespace,
          };
          return errorResult(
            args,
            classifyError(err, ctx).message,
            startedAt,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Public types (exported for testing)
// ---------------------------------------------------------------------------

export type Severity = "critical" | "warning" | "info";

export interface WorkloadRef {
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  name: string;
  namespace?: string;
}

export interface WorkloadDiffArgs {
  source: WorkloadRef;
  target: WorkloadRef;
  includeHpa?: boolean;
  includePdb?: boolean;
  ignoreLabels?: string[];
  ignoreAnnotations?: string[];
  ignoreEnvVars?: string[];
}

export interface Finding {
  category: string;
  severity: Severity;
  message: string;
  source?: string;
  target?: string;
}

export interface WorkloadDiffResult {
  meta: {
    source: string;
    target: string;
    generatedAt: string;
    durationMs: number;
  };
  verdict: "in_sync" | "drift_detected" | "comparison_failed";
  summary: { critical: number; warning: number; info: number };
  critical: Finding[];
  warning: Finding[];
  info: Finding[];
  reason?: string;
}

interface DiffOptions {
  includeHpa: boolean;
  includePdb: boolean;
  ignoreLabels: Set<string>;
  ignoreAnnotations: Set<string>;
  ignoreEnvVars: Set<string>;
}

// Loose type that covers Deployment / StatefulSet / DaemonSet for our purposes
interface WorkloadShape {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template?: {
      metadata?: {
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
      spec?: {
        containers?: ContainerShape[];
        nodeSelector?: Record<string, string>;
        tolerations?: Array<{
          key?: string;
          operator?: string;
          value?: string;
          effect?: string;
        }>;
        affinity?: unknown;
        serviceAccountName?: string;
        priorityClassName?: string;
      };
    };
  };
}

interface ContainerShape {
  name?: string;
  image?: string;
  env?: Array<{
    name?: string;
    value?: string;
    valueFrom?: unknown;
  }>;
  envFrom?: Array<{
    configMapRef?: { name?: string };
    secretRef?: { name?: string };
  }>;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  volumeMounts?: Array<{ name?: string; mountPath?: string }>;
  ports?: Array<{ containerPort?: number; name?: string; protocol?: string }>;
}

// ---------------------------------------------------------------------------
// Pure diff helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compare two workloads' specs and return a flat list of findings.
 * Pure function — no network calls. Exported for testing.
 */
export function diffWorkloads(
  source: WorkloadShape,
  target: WorkloadShape,
  kind: string,
  opts: DiffOptions,
): Finding[] {
  const findings: Finding[] = [];

  findings.push(...diffReplicas(source, target, kind));
  findings.push(...diffContainers(source, target, opts));
  findings.push(...diffScheduling(source, target));
  findings.push(...diffMeta(source, target, opts));

  return findings;
}

export function diffReplicas(
  source: WorkloadShape,
  target: WorkloadShape,
  kind: string,
): Finding[] {
  // DaemonSet doesn't have a meaningful spec.replicas — skip.
  if (kind === "DaemonSet") return [];
  const s = source.spec?.replicas ?? 0;
  const t = target.spec?.replicas ?? 0;
  if (s === t) return [];
  return [
    {
      category: "Replicas",
      severity: "warning",
      message: `Replicas differ: source=${s}, target=${t}`,
      source: String(s),
      target: String(t),
    },
  ];
}

export function diffContainers(
  source: WorkloadShape,
  target: WorkloadShape,
  opts: DiffOptions,
): Finding[] {
  const findings: Finding[] = [];
  const sourceContainers = source.spec?.template?.spec?.containers ?? [];
  const targetContainers = target.spec?.template?.spec?.containers ?? [];

  if (sourceContainers.length !== targetContainers.length) {
    findings.push({
      category: "Container count",
      severity: "critical",
      message: `Container count differs: source=${sourceContainers.length}, target=${targetContainers.length}`,
      source: String(sourceContainers.length),
      target: String(targetContainers.length),
    });
    return findings; // Don't try to align if counts differ
  }

  // Match containers by name (or position if no names match)
  const targetByName = new Map<string, ContainerShape>();
  for (const c of targetContainers) {
    if (c.name) targetByName.set(c.name, c);
  }

  for (let i = 0; i < sourceContainers.length; i++) {
    const sc = sourceContainers[i];
    const tc = sc.name && targetByName.has(sc.name)
      ? targetByName.get(sc.name)!
      : targetContainers[i];
    findings.push(...diffContainerPair(sc, tc, opts));
  }

  return findings;
}

export function diffContainerPair(
  source: ContainerShape,
  target: ContainerShape,
  opts: DiffOptions,
): Finding[] {
  const findings: Finding[] = [];
  const containerLabel = source.name ?? "<unnamed>";

  // Image is the most important diff — always critical
  if (source.image !== target.image) {
    findings.push({
      category: "Image",
      severity: "critical",
      message: `Image differs in container '${containerLabel}': source=${source.image ?? "<unset>"}, target=${target.image ?? "<unset>"}`,
      source: source.image,
      target: target.image,
    });
  }

  // Resources
  const sReq = source.resources?.requests;
  const tReq = target.resources?.requests;
  if ((sReq?.cpu ?? "") !== (tReq?.cpu ?? "")) {
    findings.push({
      category: "CPU request",
      severity: "warning",
      message: `CPU request differs in '${containerLabel}': source=${sReq?.cpu ?? "<unset>"}, target=${tReq?.cpu ?? "<unset>"}`,
      source: sReq?.cpu,
      target: tReq?.cpu,
    });
  }
  if ((sReq?.memory ?? "") !== (tReq?.memory ?? "")) {
    findings.push({
      category: "Memory request",
      severity: "warning",
      message: `Memory request differs in '${containerLabel}': source=${sReq?.memory ?? "<unset>"}, target=${tReq?.memory ?? "<unset>"}`,
      source: sReq?.memory,
      target: tReq?.memory,
    });
  }
  const sLim = source.resources?.limits;
  const tLim = target.resources?.limits;
  if ((sLim?.cpu ?? "") !== (tLim?.cpu ?? "")) {
    findings.push({
      category: "CPU limit",
      severity: "warning",
      message: `CPU limit differs in '${containerLabel}': source=${sLim?.cpu ?? "<unset>"}, target=${tLim?.cpu ?? "<unset>"}`,
    });
  }
  if ((sLim?.memory ?? "") !== (tLim?.memory ?? "")) {
    findings.push({
      category: "Memory limit",
      severity: "warning",
      message: `Memory limit differs in '${containerLabel}': source=${sLim?.memory ?? "<unset>"}, target=${tLim?.memory ?? "<unset>"}`,
    });
  }

  // Env vars (info severity — often intentional)
  const envDiff = diffEnvVars(source.env ?? [], target.env ?? [], opts.ignoreEnvVars);
  if (envDiff.length > 0) {
    findings.push({
      category: "Environment variables",
      severity: "info",
      message: `${envDiff.length} environment variable(s) differ in '${containerLabel}': ${envDiff.slice(0, 5).join(", ")}${envDiff.length > 5 ? `, +${envDiff.length - 5} more` : ""}`,
    });
  }

  // ConfigMap/Secret references (info severity)
  const sRefs = collectEnvFromRefs(source.envFrom ?? []);
  const tRefs = collectEnvFromRefs(target.envFrom ?? []);
  for (const ref of sRefs) {
    if (!tRefs.has(ref)) {
      findings.push({
        category: "ConfigMap/Secret reference",
        severity: "info",
        message: `Reference '${ref}' present in source but missing in target ('${containerLabel}')`,
      });
    }
  }
  for (const ref of tRefs) {
    if (!sRefs.has(ref)) {
      findings.push({
        category: "ConfigMap/Secret reference",
        severity: "info",
        message: `Reference '${ref}' present in target but missing in source ('${containerLabel}')`,
      });
    }
  }

  return findings;
}

/**
 * Diff env var arrays — returns names of variables that differ (present on
 * one side only OR present on both sides with different values).
 */
export function diffEnvVars(
  sourceEnv: Array<{ name?: string; value?: string }>,
  targetEnv: Array<{ name?: string; value?: string }>,
  ignored: Set<string>,
): string[] {
  const sourceMap = new Map<string, string>();
  for (const e of sourceEnv) {
    if (e.name && !ignored.has(e.name)) sourceMap.set(e.name, e.value ?? "");
  }
  const targetMap = new Map<string, string>();
  for (const e of targetEnv) {
    if (e.name && !ignored.has(e.name)) targetMap.set(e.name, e.value ?? "");
  }
  const differing: string[] = [];
  for (const [name, value] of sourceMap.entries()) {
    if (targetMap.get(name) !== value) differing.push(name);
  }
  for (const name of targetMap.keys()) {
    if (!sourceMap.has(name)) differing.push(name);
  }
  return [...new Set(differing)];
}

export function collectEnvFromRefs(
  envFrom: Array<{
    configMapRef?: { name?: string };
    secretRef?: { name?: string };
  }>,
): Set<string> {
  const refs = new Set<string>();
  for (const ef of envFrom) {
    if (ef.configMapRef?.name) refs.add(`ConfigMap/${ef.configMapRef.name}`);
    if (ef.secretRef?.name) refs.add(`Secret/${ef.secretRef.name}`);
  }
  return refs;
}

export function diffScheduling(
  source: WorkloadShape,
  target: WorkloadShape,
): Finding[] {
  const findings: Finding[] = [];
  const sSpec = source.spec?.template?.spec;
  const tSpec = target.spec?.template?.spec;

  // NodeSelector
  const sNs = JSON.stringify(sSpec?.nodeSelector ?? {});
  const tNs = JSON.stringify(tSpec?.nodeSelector ?? {});
  if (sNs !== tNs) {
    findings.push({
      category: "NodeSelector",
      severity: "warning",
      message: "NodeSelector differs between source and target",
      source: sNs,
      target: tNs,
    });
  }

  // Tolerations (count only — full deep-diff is overkill for this tool)
  const sTol = sSpec?.tolerations?.length ?? 0;
  const tTol = tSpec?.tolerations?.length ?? 0;
  if (sTol !== tTol) {
    findings.push({
      category: "Tolerations",
      severity: "warning",
      message: `Toleration count differs: source=${sTol}, target=${tTol}`,
    });
  }

  // ServiceAccount
  if (sSpec?.serviceAccountName !== tSpec?.serviceAccountName) {
    findings.push({
      category: "ServiceAccount",
      severity: "warning",
      message: `ServiceAccount differs: source=${sSpec?.serviceAccountName ?? "<default>"}, target=${tSpec?.serviceAccountName ?? "<default>"}`,
      source: sSpec?.serviceAccountName,
      target: tSpec?.serviceAccountName,
    });
  }

  // PriorityClass
  if (sSpec?.priorityClassName !== tSpec?.priorityClassName) {
    findings.push({
      category: "PriorityClass",
      severity: "warning",
      message: `PriorityClass differs: source=${sSpec?.priorityClassName ?? "<unset>"}, target=${tSpec?.priorityClassName ?? "<unset>"}`,
    });
  }

  return findings;
}

export function diffMeta(
  source: WorkloadShape,
  target: WorkloadShape,
  opts: DiffOptions,
): Finding[] {
  const findings: Finding[] = [];

  const sLabels = filterKeys(source.metadata?.labels ?? {}, opts.ignoreLabels);
  const tLabels = filterKeys(target.metadata?.labels ?? {}, opts.ignoreLabels);
  const labelDiff = diffMaps(sLabels, tLabels);
  if (labelDiff.length > 0) {
    findings.push({
      category: "Labels",
      severity: "info",
      message: `${labelDiff.length} label(s) differ: ${labelDiff.slice(0, 5).join(", ")}${labelDiff.length > 5 ? `, +${labelDiff.length - 5} more` : ""}`,
    });
  }

  const sAnnos = filterKeys(
    source.metadata?.annotations ?? {},
    opts.ignoreAnnotations,
  );
  const tAnnos = filterKeys(
    target.metadata?.annotations ?? {},
    opts.ignoreAnnotations,
  );
  const annoDiff = diffMaps(sAnnos, tAnnos);
  if (annoDiff.length > 0) {
    findings.push({
      category: "Annotations",
      severity: "info",
      message: `${annoDiff.length} annotation(s) differ: ${annoDiff.slice(0, 5).join(", ")}${annoDiff.length > 5 ? `, +${annoDiff.length - 5} more` : ""}`,
    });
  }

  return findings;
}

export function filterKeys(
  m: Record<string, string>,
  ignored: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (!ignored.has(k)) out[k] = v;
  }
  return out;
}

export function diffMaps(
  a: Record<string, string>,
  b: Record<string, string>,
): string[] {
  const differing: string[] = [];
  for (const k of Object.keys(a)) {
    if (a[k] !== b[k]) differing.push(k);
  }
  for (const k of Object.keys(b)) {
    if (!(k in a)) differing.push(k);
  }
  return [...new Set(differing)];
}

// ---------------------------------------------------------------------------
// Async helpers (HPA + PDB lookups)
// ---------------------------------------------------------------------------

async function compareHpas(
  k8sClient: K8sClient,
  args: WorkloadDiffArgs,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  try {
    const kc = (k8sClient as any).kc as k8s.KubeConfig | undefined;
    if (!kc) return findings;
    const hpa = kc.makeApiClient(k8s.AutoscalingV2Api);

    const fetchHpaForTarget = async (
      ref: WorkloadRef,
    ): Promise<{
      minReplicas?: number;
      maxReplicas?: number;
      name?: string;
    } | null> => {
      try {
        const ns = ref.namespace ?? "default";
        const list =
          await hpa.listNamespacedHorizontalPodAutoscaler({ namespace: ns });
        for (const h of list.items) {
          const tref = h.spec?.scaleTargetRef;
          if (
            tref?.kind === ref.kind &&
            tref?.name === ref.name
          ) {
            return {
              minReplicas: h.spec?.minReplicas,
              maxReplicas: h.spec?.maxReplicas,
              name: h.metadata?.name,
            };
          }
        }
        return null;
      } catch {
        return null;
      }
    };

    const [s, t] = await Promise.all([
      fetchHpaForTarget(args.source),
      fetchHpaForTarget(args.target),
    ]);

    if (!s && t) {
      findings.push({
        category: "HPA",
        severity: "warning",
        message: `Target has HPA '${t.name}' (min=${t.minReplicas}, max=${t.maxReplicas}); source has no HPA`,
      });
    } else if (s && !t) {
      findings.push({
        category: "HPA",
        severity: "warning",
        message: `Source has HPA '${s.name}' (min=${s.minReplicas}, max=${s.maxReplicas}); target has no HPA`,
      });
    } else if (s && t) {
      if (s.minReplicas !== t.minReplicas) {
        findings.push({
          category: "HPA minReplicas",
          severity: "warning",
          message: `HPA minReplicas differs: source=${s.minReplicas}, target=${t.minReplicas}`,
        });
      }
      if (s.maxReplicas !== t.maxReplicas) {
        findings.push({
          category: "HPA maxReplicas",
          severity: "warning",
          message: `HPA maxReplicas differs: source=${s.maxReplicas}, target=${t.maxReplicas}`,
        });
      }
    }
  } catch {
    /* HPA API may not be reachable; skip */
  }
  return findings;
}

async function comparePdbs(
  k8sClient: K8sClient,
  args: WorkloadDiffArgs,
  source: WorkloadShape,
  target: WorkloadShape,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  try {
    const kc = (k8sClient as any).kc as k8s.KubeConfig | undefined;
    if (!kc) return findings;
    const policy = kc.makeApiClient(k8s.PolicyV1Api);

    const sLabels = source.spec?.selector?.matchLabels ?? {};
    const tLabels = target.spec?.selector?.matchLabels ?? {};

    const fetchPdb = async (
      ref: WorkloadRef,
      labels: Record<string, string>,
    ): Promise<{ name: string; minAvailable?: unknown } | null> => {
      try {
        const ns = ref.namespace ?? "default";
        const list = await policy.listNamespacedPodDisruptionBudget({
          namespace: ns,
        });
        for (const p of list.items) {
          const sel = p.spec?.selector?.matchLabels ?? {};
          if (selectorCovers(labels, sel)) {
            return {
              name: p.metadata?.name ?? "?",
              minAvailable: p.spec?.minAvailable,
            };
          }
        }
        return null;
      } catch {
        return null;
      }
    };

    const [s, t] = await Promise.all([
      fetchPdb(args.source, sLabels),
      fetchPdb(args.target, tLabels),
    ]);

    if (!s && t) {
      findings.push({
        category: "PDB coverage",
        severity: "warning",
        message: `Target covered by PDB '${t.name}' (minAvailable=${t.minAvailable}); source has no PDB`,
      });
    } else if (s && !t) {
      findings.push({
        category: "PDB coverage",
        severity: "warning",
        message: `Source covered by PDB '${s.name}' (minAvailable=${s.minAvailable}); target has no PDB`,
      });
    } else if (s && t && s.minAvailable !== t.minAvailable) {
      findings.push({
        category: "PDB minAvailable",
        severity: "info",
        message: `PDB minAvailable differs: source=${s.minAvailable}, target=${t.minAvailable}`,
      });
    }
  } catch {
    /* Policy API may not be reachable; skip */
  }
  return findings;
}

/**
 * Returns true when `selector` is fully present in `labels` with matching values.
 * Empty selector returns false (won't match anything — same convention as elsewhere).
 */
export function selectorCovers(
  labels: Record<string, string>,
  selector: Record<string, string>,
): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchWorkload(
  k8sClient: K8sClient,
  ref: WorkloadRef,
): Promise<WorkloadShape | null> {
  const apps = k8sClient.getAppsV1Api();
  const ns = ref.namespace ?? "default";
  try {
    if (ref.kind === "Deployment") {
      return await apps.readNamespacedDeployment({ name: ref.name, namespace: ns });
    }
    if (ref.kind === "StatefulSet") {
      return await apps.readNamespacedStatefulSet({ name: ref.name, namespace: ns });
    }
    return await apps.readNamespacedDaemonSet({ name: ref.name, namespace: ns });
  } catch {
    return null;
  }
}

function refLabel(r: WorkloadRef): string {
  return `${r.kind}/${r.namespace ?? "default"}/${r.name}`;
}

function errorResult(
  args: WorkloadDiffArgs,
  reason: string,
  startedAt: number,
): WorkloadDiffResult {
  return {
    meta: {
      source: refLabel(args.source),
      target: refLabel(args.target),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    },
    verdict: "comparison_failed",
    summary: { critical: 0, warning: 0, info: 0 },
    critical: [],
    warning: [],
    info: [],
    reason,
  };
}

function assemble(
  args: WorkloadDiffArgs,
  findings: Finding[],
  startedAt: number,
): WorkloadDiffResult {
  const critical: Finding[] = [];
  const warning: Finding[] = [];
  const info: Finding[] = [];
  for (const f of findings) {
    if (f.severity === "critical") critical.push(f);
    else if (f.severity === "warning") warning.push(f);
    else info.push(f);
  }
  return {
    meta: {
      source: refLabel(args.source),
      target: refLabel(args.target),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    },
    verdict: findings.length === 0 ? "in_sync" : "drift_detected",
    summary: {
      critical: critical.length,
      warning: warning.length,
      info: info.length,
    },
    critical,
    warning,
    info,
  };
}
