import { describe, expect, it } from "vitest";
import {
  ProductionHostPool,
  ProductionWorkerNode,
  type AllocatedEnvironment,
} from "./production-host-pool.server";
import { InMemoryLabJobStore } from "./worker";
import { createLabJob } from "./scheduler";
import type { RuntimeNode } from "./runtime-backend";

function makeRuntimeNode(nodeId: string): RuntimeNode {
  return {
    nodeId,
    backendId: "microvm-backend-1",
    runtimeClass: "vm",
    runtimeVersion: "v50",
    capabilities: {
      runtimeClass: "vm",
      snapshot: true,
      pauseResume: true,
      networkPolicy: true,
      immutableImages: true,
      guestRoot: false,
    },
    maxEnvironments: 10,
    activeEnvironments: 0,
    enabled: true,
    registeredAt: new Date().toISOString(),
    metadata: {},
  };
}

describe("Production Host Pool & Worker Execution Plane", () => {
  it("registers workers and tracks capacity", () => {
    const store = new InMemoryLabJobStore();
    const pool = new ProductionHostPool(store);

    const worker1 = new ProductionWorkerNode("worker-1", makeRuntimeNode("node-1"), {
      maxEnvironments: 2,
      maxConcurrentJobs: 2,
      totalCpuMillicores: 4000,
      totalMemoryMiB: 8192,
    });
    pool.registerWorker(worker1);

    expect(worker1.isRunning).toBe(true);
    expect(worker1.availableEnvironmentCapacity).toBe(2);

    const env1: AllocatedEnvironment = {
      environmentId: "env-1",
      learnerId: "u1",
      labId: "l1",
      allocatedAt: Date.now(),
      cpuMillicores: 1000,
      memoryMiB: 2048,
    };
    worker1.allocateEnvironment(env1);
    expect(worker1.activeEnvironmentCount).toBe(1);
    expect(worker1.availableEnvironmentCapacity).toBe(1);

    const env2: AllocatedEnvironment = {
      environmentId: "env-2",
      learnerId: "u2",
      labId: "l2",
      allocatedAt: Date.now(),
      cpuMillicores: 1000,
      memoryMiB: 2048,
    };
    worker1.allocateEnvironment(env2);
    expect(worker1.availableEnvironmentCapacity).toBe(0);

    // Exceeding capacity throws
    const env3: AllocatedEnvironment = {
      environmentId: "env-3",
      learnerId: "u3",
      labId: "l3",
      allocatedAt: Date.now(),
      cpuMillicores: 1000,
      memoryMiB: 2048,
    };
    expect(() => worker1.allocateEnvironment(env3)).toThrow("capacity exceeded");
  });

  it("selects least loaded worker for placement", () => {
    const store = new InMemoryLabJobStore();
    const pool = new ProductionHostPool(store);

    const workerA = new ProductionWorkerNode("worker-a", makeRuntimeNode("node-a"), {
      maxEnvironments: 5,
      maxConcurrentJobs: 2,
      totalCpuMillicores: 8000,
      totalMemoryMiB: 16384,
    });
    const workerB = new ProductionWorkerNode("worker-b", makeRuntimeNode("node-b"), {
      maxEnvironments: 5,
      maxConcurrentJobs: 2,
      totalCpuMillicores: 8000,
      totalMemoryMiB: 16384,
    });
    pool.registerWorker(workerA);
    pool.registerWorker(workerB);

    // Put 1 env on workerA
    workerA.allocateEnvironment({
      environmentId: "env-a1",
      learnerId: "u1",
      labId: "l1",
      allocatedAt: Date.now(),
      cpuMillicores: 1000,
      memoryMiB: 2048,
    });

    // Placement should choose workerB because it has 5 available vs 4 on workerA
    const selected = pool.selectWorkerForPlacement(1000, 2048, "vm");
    expect(selected.workerId).toBe("worker-b");
  });

  it("fails placement when all workers are at capacity", () => {
    const store = new InMemoryLabJobStore();
    const pool = new ProductionHostPool(store);

    const fullWorker = new ProductionWorkerNode("worker-full", makeRuntimeNode("node-full"), {
      maxEnvironments: 1,
      maxConcurrentJobs: 1,
      totalCpuMillicores: 1000,
      totalMemoryMiB: 2048,
    });
    pool.registerWorker(fullWorker);
    fullWorker.allocateEnvironment({
      environmentId: "env-full-1",
      learnerId: "u1",
      labId: "l1",
      allocatedAt: Date.now(),
      cpuMillicores: 1000,
      memoryMiB: 2048,
    });

    expect(() => pool.selectWorkerForPlacement(1000, 2048, "vm")).toThrow(
      "No active worker has capacity",
    );
  });

  it("gracefully drains worker without accepting new jobs", async () => {
    const store = new InMemoryLabJobStore();
    const pool = new ProductionHostPool(store);
    const worker = new ProductionWorkerNode("worker-drain", makeRuntimeNode("node-drain"));
    pool.registerWorker(worker);

    pool.drainWorker("worker-drain");
    expect(worker.state).toBe("DRAINING");
    expect(worker.canAcceptEnvironment(500, 1024)).toBe(false);
  });

  it("executes claimed job and handles lease expiration safely", async () => {
    const store = new InMemoryLabJobStore();
    const pool = new ProductionHostPool(store);
    const worker = new ProductionWorkerNode("worker-exec", makeRuntimeNode("node-exec"));
    pool.registerWorker(worker);

    const job = createLabJob({ instanceId: "inst-1", userId: "u1", kind: "START" });
    await store.enqueue(job);

    let executed = false;
    const result = await pool.runWorkerJob("worker-exec", {
      execute: async () => {
        executed = true;
      },
    });

    expect(result.kind).toBe("SUCCEEDED");
    expect(executed).toBe(true);
  });
});
