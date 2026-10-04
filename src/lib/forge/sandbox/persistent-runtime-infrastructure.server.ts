/**
 * Persistent Supabase implementation of RuntimeNodeRegistryV17 and RuntimeOperationStoreV17.
 *
 * Backed by the v17 PostgreSQL tables and security-definer RPCs in:
 * supabase/migrations/20260922000000_runtime_infrastructure_v17.sql
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { RuntimeClass } from "./contract";
import type { RuntimeNode } from "./runtime-backend";
import type {
  RuntimeNodeLease,
  RuntimeNodeRegistration,
  RuntimeNodeRegistryV17,
  RuntimeOperation,
  RuntimeOperationKind,
  RuntimeOperationStoreV17,
} from "./runtime-infrastructure";

type Db = SupabaseClient<Database>;
type NodeRow = Database["public"]["Tables"]["runtime_nodes"]["Row"];
type LeaseRow = Database["public"]["Tables"]["runtime_node_leases"]["Row"];
type OpRow = Database["public"]["Tables"]["runtime_operations"]["Row"];

function toRegistration(row: NodeRow): RuntimeNodeRegistration {
  return {
    nodeId: row.node_id,
    backendId: row.backend_id,
    runtimeClass: row.runtime_class as RuntimeClass,
    runtimeVersion: row.runtime_version,
    capabilities: (row.capabilities ?? {}) as any,
    maxEnvironments: row.max_environments,
    activeEnvironments: row.active_environments,
    status: row.status as any,
    enabled: row.enabled,
    registeredAt: row.registered_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    heartbeatTtlMs: (row.heartbeat_ttl_seconds ?? 30) * 1000,
    registrationGeneration: row.registration_generation,
    metadata: (row.metadata ?? {}) as Record<string, string>,
  };
}

function toLease(row: LeaseRow): RuntimeNodeLease {
  return {
    leaseId: row.lease_id,
    nodeId: row.node_id,
    ownerId: row.owner_id,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function toOperation(row: OpRow): RuntimeOperation {
  return {
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind as RuntimeOperationKind,
    environmentId: row.environment_id,
    nodeId: row.node_id,
    status: row.status as any,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseUntil: row.lease_until,
    ownerId: row.owner_id,
    resultRef: row.result_ref,
    error: row.error,
  };
}

export class SupabaseRuntimeNodeRegistry implements RuntimeNodeRegistryV17 {
  constructor(private readonly db: Db) {}

  register(node: RuntimeNode, now = new Date()): RuntimeNodeRegistration {
    throw new Error(
      "Synchronous register not supported on SupabaseRuntimeNodeRegistry; use registerAsync.",
    );
  }

  async registerAsync(
    node: RuntimeNode,
    credentialHash: string,
    now = new Date(),
  ): Promise<RuntimeNodeRegistration> {
    const res = await (this.db as any).rpc("register_runtime_node", {
      p_node_id: node.nodeId,
      p_backend_id: node.backendId,
      p_runtime_class: node.runtimeClass,
      p_runtime_version: node.runtimeVersion,
      p_capabilities: node.capabilities,
      p_max_environments: node.maxEnvironments,
      p_credential_hash: credentialHash,
      p_metadata: node.metadata,
      p_now: now.toISOString(),
    });
    if (res.error) throw new Error(res.error.message);
    const row = res.data?.[0];
    if (!row) throw new Error("register_runtime_node returned no rows");
    return toRegistration(row);
  }

  heartbeatNode(nodeId: string, generation: number, now = new Date()): RuntimeNodeRegistration {
    throw new Error("Use heartbeatNodeAsync");
  }

  async heartbeatNodeAsync(
    nodeId: string,
    generation: number,
    now = new Date(),
  ): Promise<RuntimeNodeRegistration> {
    const res = await (this.db as any).rpc("heartbeat_runtime_node", {
      p_node_id: nodeId,
      p_registration_generation: generation,
      p_now: now.toISOString(),
    });
    if (res.error) throw new Error(res.error.message);
    const row = res.data?.[0];
    if (!row) throw new Error("heartbeat_runtime_node returned no rows");
    return toRegistration(row);
  }

  markExpired(now = new Date()): RuntimeNodeRegistration[] {
    return [];
  }

  getNode(nodeId: string, now = new Date()): RuntimeNodeRegistration | null {
    throw new Error("Use getNodeAsync");
  }

  async getNodeAsync(nodeId: string): Promise<RuntimeNodeRegistration | null> {
    const res = await this.db.from("runtime_nodes").select("*").eq("node_id", nodeId).maybeSingle();
    if (res.error || !res.data) return null;
    return toRegistration(res.data);
  }

  select(runtimeClass: RuntimeClass, now = new Date()): RuntimeNodeRegistration {
    throw new Error("Use selectAsync");
  }

  async selectAsync(
    runtimeClass: RuntimeClass,
    now = new Date(),
  ): Promise<RuntimeNodeRegistration> {
    const res = await (this.db as any).rpc("select_runtime_node", {
      p_runtime_class: runtimeClass,
      p_now: now.toISOString(),
    });
    if (res.error) throw new Error(res.error.message);
    const row = res.data?.[0];
    if (!row) throw new Error(`No active runtime node is available for ${runtimeClass}.`);
    return toRegistration(row);
  }

  acquireLease(
    nodeId: string,
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): RuntimeNodeLease {
    throw new Error("Use acquireLeaseAsync");
  }

  async acquireLeaseAsync(
    nodeId: string,
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<RuntimeNodeLease> {
    const res = await (this.db as any).rpc("acquire_runtime_node_lease", {
      p_node_id: nodeId,
      p_owner_id: ownerId,
      p_lease_seconds: Math.round(leaseMs / 1000),
      p_now: now.toISOString(),
    });
    if (res.error) throw new Error(res.error.message);
    const row = res.data?.[0];
    if (!row) throw new Error("Failed to acquire runtime node lease");
    return toLease(row);
  }

  heartbeatLease(
    lease: RuntimeNodeLease,
    leaseMs: number,
    now = new Date(),
  ): RuntimeNodeLease | null {
    throw new Error("Use heartbeatLeaseAsync");
  }

  async heartbeatLeaseAsync(
    lease: RuntimeNodeLease,
    leaseMs: number,
    now = new Date(),
  ): Promise<RuntimeNodeLease | null> {
    const res = await (this.db as any).rpc("heartbeat_runtime_node_lease", {
      p_lease_id: lease.leaseId,
      p_node_id: lease.nodeId,
      p_owner_id: lease.ownerId,
      p_lease_seconds: Math.round(leaseMs / 1000),
      p_now: now.toISOString(),
    });
    if (res.error || !res.data?.[0]) return null;
    return toLease(res.data[0]);
  }

  releaseLease(lease: RuntimeNodeLease, now = new Date()): boolean {
    throw new Error("Use releaseLeaseAsync");
  }

  async releaseLeaseAsync(lease: RuntimeNodeLease, now = new Date()): Promise<boolean> {
    const res = await (this.db as any).rpc("release_runtime_node_lease", {
      p_lease_id: lease.leaseId,
      p_node_id: lease.nodeId,
      p_owner_id: lease.ownerId,
      p_now: now.toISOString(),
    });
    return !res.error && res.data === true;
  }
}

export class SupabaseRuntimeOperationStore implements RuntimeOperationStoreV17 {
  constructor(private readonly db: Db) {}

  begin(input: {
    idempotencyKey: string;
    kind: RuntimeOperationKind;
    environmentId: string;
    nodeId?: string | null;
    now?: Date;
  }): RuntimeOperation {
    throw new Error("Use beginAsync");
  }

  async beginAsync(input: {
    idempotencyKey: string;
    kind: RuntimeOperationKind;
    environmentId: string;
    nodeId?: string | null;
    now?: Date;
  }): Promise<RuntimeOperation> {
    const now = input.now ?? new Date();
    const res = await (this.db as any).rpc("begin_runtime_operation", {
      p_idempotency_key: input.idempotencyKey,
      p_kind: input.kind,
      p_environment_id: input.environmentId,
      p_node_id: input.nodeId ?? null,
      p_now: now.toISOString(),
    });
    if (res.error) throw new Error(res.error.message);
    const row = res.data?.[0];
    if (!row) throw new Error("begin_runtime_operation returned no row");
    return toOperation(row);
  }

  claim(
    operationId: string,
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): RuntimeOperation | null {
    throw new Error("Use claimAsync");
  }

  async claimAsync(
    operationId: string,
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<RuntimeOperation | null> {
    const res = await (this.db as any).rpc("claim_runtime_operation", {
      p_operation_id: operationId,
      p_owner_id: ownerId,
      p_lease_seconds: Math.round(leaseMs / 1000),
      p_now: now.toISOString(),
    });
    if (res.error || !res.data?.[0]) return null;
    return toOperation(res.data[0]);
  }

  heartbeat(
    operationId: string,
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): RuntimeOperation | null {
    throw new Error("Use heartbeatAsync");
  }

  async heartbeatAsync(
    operationId: string,
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<RuntimeOperation | null> {
    const res = await (this.db as any).rpc("heartbeat_runtime_operation", {
      p_operation_id: operationId,
      p_owner_id: ownerId,
      p_lease_seconds: Math.round(leaseMs / 1000),
      p_now: now.toISOString(),
    });
    if (res.error || !res.data?.[0]) return null;
    return toOperation(res.data[0]);
  }

  complete(
    operationId: string,
    ownerId: string,
    resultRef: string | null = null,
    now = new Date(),
  ): RuntimeOperation | null {
    throw new Error("Use completeAsync");
  }

  async completeAsync(
    operationId: string,
    ownerId: string,
    resultRef: string | null = null,
    now = new Date(),
  ): Promise<RuntimeOperation | null> {
    const res = await (this.db as any).rpc("complete_runtime_operation", {
      p_operation_id: operationId,
      p_owner_id: ownerId,
      p_result_ref: resultRef,
      p_now: now.toISOString(),
    });
    if (res.error || !res.data?.[0]) return null;
    return toOperation(res.data[0]);
  }

  fail(
    operationId: string,
    ownerId: string,
    error: string,
    now = new Date(),
  ): RuntimeOperation | null {
    throw new Error("Use failAsync");
  }

  async failAsync(
    operationId: string,
    ownerId: string,
    error: string,
    now = new Date(),
  ): Promise<RuntimeOperation | null> {
    const res = await (this.db as any).rpc("fail_runtime_operation", {
      p_operation_id: operationId,
      p_owner_id: ownerId,
      p_error: error,
      p_now: now.toISOString(),
    });
    if (res.error || !res.data?.[0]) return null;
    return toOperation(res.data[0]);
  }

  recoverExpired(now = new Date()): RuntimeOperation[] {
    throw new Error("Use recoverExpiredAsync");
  }

  async recoverExpiredAsync(now = new Date()): Promise<RuntimeOperation[]> {
    const res = await (this.db as any).rpc("recover_expired_runtime_operations", {
      p_now: now.toISOString(),
    });
    if (res.error || !res.data) return [];
    return (res.data as OpRow[]).map(toOperation);
  }

  get(operationId: string): RuntimeOperation | null {
    throw new Error("Use getAsync");
  }

  async getAsync(operationId: string): Promise<RuntimeOperation | null> {
    const res = await this.db
      .from("runtime_operations")
      .select("*")
      .eq("operation_id", operationId)
      .maybeSingle();
    if (res.error || !res.data) return null;
    return toOperation(res.data);
  }
}
