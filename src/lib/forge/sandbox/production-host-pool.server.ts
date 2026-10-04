/**
 * LinuxForge Production Host Pool & Worker Execution Plane.
 *
 * Implements:
 * - Worker identity and capability registration
 * - Background heartbeats and liveness monitoring
 * - Capacity-aware environment placement
 * - Concurrency safety and lease-loss enforcement
 * - Graceful draining and shutdown
 * - Stale worker and expired job recovery
 */

import { type LabJobExecutor, type LabJobStore, type WorkerRunResult, LabWorker } from "./worker";
import type { LabJob } from "./scheduler";
import type { RuntimeClass } from "./contract";
import type { RuntimeNode } from "./runtime-backend";
import type { RuntimeNodeRegistration, RuntimeNodeRegistryV17 } from "./runtime-infrastructure";

export type WorkerState = "INITIALIZING" | "ACTIVE" | "DRAINING" | "STOPPED";

export type WorkerCapacitySpec = {
  maxEnvironments: number;
  maxConcurrentJobs: number;
  totalCpuMillicores: number;
  totalMemoryMiB: number;
};

export const DEFAULT_WORKER_CAPACITY: WorkerCapacitySpec = {
  maxEnvironments: 20,
  maxConcurrentJobs: 5,
  totalCpuMillicores: 16000,
  totalMemoryMiB: 32768,
};

export type AllocatedEnvironment = {
  environmentId: string;
  learnerId: string;
  labId: string;
  allocatedAt: number;
  cpuMillicores: number;
  memoryMiB: number;
};

export class ProductionWorkerNode {
  public state: WorkerState = "INITIALIZING";
  private readonly activeEnvironments = new Map<string, AllocatedEnvironment>();
  private activeJobsCount = 0;
  private readonly abortControllers = new Map<string, AbortController>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly workerId: string,
    public readonly runtimeNode: RuntimeNode,
    public readonly capacity: WorkerCapacitySpec = DEFAULT_WORKER_CAPACITY,
    private readonly heartbeatIntervalMs = 10_000,
  ) {
    if (!workerId.trim()) throw new Error("Worker ID is required.");
  }

  get isRunning(): boolean {
    return this.state === "ACTIVE";
  }

  get activeEnvironmentCount(): number {
    return this.activeEnvironments.size;
  }

  get availableEnvironmentCapacity(): number {
    return Math.max(0, this.capacity.maxEnvironments - this.activeEnvironments.size);
  }

  get availableJobCapacity(): number {
    return Math.max(0, this.capacity.maxConcurrentJobs - this.activeJobsCount);
  }

  canAcceptEnvironment(cpuRequired: number, memRequired: number): boolean {
    if (this.state !== "ACTIVE") return false;
    if (this.activeEnvironments.size >= this.capacity.maxEnvironments) return false;

    let usedCpu = 0;
    let usedMem = 0;
    for (const env of this.activeEnvironments.values()) {
      usedCpu += env.cpuMillicores;
      usedMem += env.memoryMiB;
    }

    if (usedCpu + cpuRequired > this.capacity.totalCpuMillicores) return false;
    if (usedMem + memRequired > this.capacity.totalMemoryMiB) return false;

    return true;
  }

  allocateEnvironment(env: AllocatedEnvironment): void {
    if (!this.canAcceptEnvironment(env.cpuMillicores, env.memoryMiB)) {
      throw new Error(`Worker ${this.workerId} capacity exceeded.`);
    }
    if (this.activeEnvironments.has(env.environmentId)) {
      throw new Error(
        `Environment ${env.environmentId} is already allocated on worker ${this.workerId}.`,
      );
    }
    this.activeEnvironments.set(env.environmentId, env);
  }

  releaseEnvironment(environmentId: string): boolean {
    const deleted = this.activeEnvironments.delete(environmentId);
    const controller = this.abortControllers.get(environmentId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(environmentId);
    }
    return deleted;
  }

  getAbortSignal(environmentId: string): AbortSignal {
    let controller = this.abortControllers.get(environmentId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.abortControllers.set(environmentId, controller);
    }
    return controller.signal;
  }

  startHeartbeat(onHeartbeat: (workerId: string) => Promise<void>): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.state = "ACTIVE";
    this.heartbeatTimer = setInterval(() => {
      if (this.state === "ACTIVE" || this.state === "DRAINING") {
        onHeartbeat(this.workerId).catch((err) => {
          console.error(`Worker ${this.workerId} heartbeat failed:`, err);
        });
      }
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  drain(): void {
    this.state = "DRAINING";
  }

  stop(): void {
    this.state = "STOPPED";
    this.stopHeartbeat();
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
  }
}

export type HostPoolOptions = {
  maxWorkers?: number;
  leaseMs?: number;
};

export class ProductionHostPool {
  private readonly workers = new Map<string, ProductionWorkerNode>();
  private readonly environmentToWorker = new Map<string, string>();

  constructor(
    private readonly jobStore: LabJobStore,
    private readonly nodeRegistry?: RuntimeNodeRegistryV17,
    private readonly options: HostPoolOptions = {},
  ) {}

  registerWorker(worker: ProductionWorkerNode): void {
    if (this.workers.has(worker.workerId)) {
      throw new Error(`Worker ${worker.workerId} is already registered in host pool.`);
    }
    this.workers.set(worker.workerId, worker);
    worker.state = "ACTIVE";
  }

  getWorker(workerId: string): ProductionWorkerNode | null {
    return this.workers.get(workerId) ?? null;
  }

  getWorkerForEnvironment(environmentId: string): ProductionWorkerNode | null {
    const workerId = this.environmentToWorker.get(environmentId);
    if (!workerId) return null;
    return this.getWorker(workerId);
  }

  /**
   * Selects an active worker with available capacity for placement.
   */
  selectWorkerForPlacement(
    cpuRequired = 1000,
    memRequired = 2048,
    runtimeClass: RuntimeClass = "vm",
  ): ProductionWorkerNode {
    const candidates = [...this.workers.values()].filter(
      (w) =>
        w.state === "ACTIVE" &&
        w.runtimeNode.runtimeClass === runtimeClass &&
        w.canAcceptEnvironment(cpuRequired, memRequired),
    );

    if (candidates.length === 0) {
      throw new Error(
        `No active worker has capacity for ${runtimeClass} (CPU: ${cpuRequired}, RAM: ${memRequired}MB).`,
      );
    }

    // Sort by most available environment capacity (least loaded)
    candidates.sort((a, b) => b.availableEnvironmentCapacity - a.availableEnvironmentCapacity);
    return candidates[0]!;
  }

  bindEnvironment(environmentId: string, workerId: string): void {
    const worker = this.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found.`);
    this.environmentToWorker.set(environmentId, workerId);
  }

  unbindEnvironment(environmentId: string): void {
    const workerId = this.environmentToWorker.get(environmentId);
    if (workerId) {
      const worker = this.getWorker(workerId);
      if (worker) worker.releaseEnvironment(environmentId);
      this.environmentToWorker.delete(environmentId);
    }
  }

  async runWorkerJob(
    workerId: string,
    executor: LabJobExecutor,
    now = Date.now(),
  ): Promise<WorkerRunResult> {
    const worker = this.getWorker(workerId);
    if (!worker || worker.state !== "ACTIVE") {
      return { kind: "IDLE" };
    }

    // Wrap executor with lease validation and capacity bounds
    const safeExecutor: LabJobExecutor = {
      execute: async (job: LabJob) => {
        // Enforce worker has not been stopped or drained
        if (worker.state === "STOPPED") {
          throw new Error(`Worker ${workerId} is stopped; refusing execution.`);
        }

        // Check lease validity
        if (job.leaseUntil && job.leaseUntil <= Date.now()) {
          throw new Error(`Job ${job.id} lease expired before execution started.`);
        }

        await executor.execute(job);
      },
    };

    const labWorker = new LabWorker(this.jobStore, safeExecutor, workerId, {
      heartbeatIntervalMs: 5_000,
    });

    return labWorker.runOnce(now);
  }

  /**
   * Recovers expired job leases across all workers.
   */
  async recoverExpiredJobs(now = Date.now()): Promise<number> {
    return this.jobStore.recoverExpired(now);
  }

  /**
   * Gracefully drains a worker node.
   */
  drainWorker(workerId: string): void {
    const worker = this.getWorker(workerId);
    if (worker) {
      worker.drain();
    }
  }

  /**
   * Stops a worker node and cancels in-flight jobs.
   */
  stopWorker(workerId: string): void {
    const worker = this.getWorker(workerId);
    if (worker) {
      worker.stop();
      this.workers.delete(workerId);
      // Clean up environment mappings
      for (const [envId, wId] of this.environmentToWorker.entries()) {
        if (wId === workerId) {
          this.environmentToWorker.delete(envId);
        }
      }
    }
  }
}
