/**
 * Mission Artifact Tracking Foundation.
 *
 * Tracks files, directories, users, groups, services, and configuration objects
 * targeted or produced by learning missions across environment snapshots.
 */

import type { CanonicalEnvironmentModel, MissionArtifact, MissionArtifactKind } from "./types";

export function createMissionArtifact(params: {
  id: string;
  kind: MissionArtifactKind;
  identifier: string;
  expectedState?: Record<string, unknown>;
}): MissionArtifact {
  return {
    id: params.id,
    kind: params.kind,
    identifier: params.identifier,
    expectedState: params.expectedState,
    observedState: null,
    verified: false,
    evidence: "UNKNOWN",
  };
}

export function evaluateArtifactAgainstModel(
  artifact: MissionArtifact,
  model: CanonicalEnvironmentModel,
): MissionArtifact {
  switch (artifact.kind) {
    case "file":
    case "directory": {
      const match = model.filesystem.find((f) => f.path === artifact.identifier);
      if (!match || !match.exists) {
        return {
          ...artifact,
          observedState: null,
          verified: false,
          evidence: "OBSERVED_FACT",
        };
      }

      let verified = true;
      if (artifact.expectedState) {
        if (
          artifact.expectedState["permissions"] &&
          match.permissions !== artifact.expectedState["permissions"]
        ) {
          verified = false;
        }
        if (
          artifact.expectedState["owner"] &&
          match.owner !== artifact.expectedState["owner"]
        ) {
          verified = false;
        }
        if (
          artifact.expectedState["group"] &&
          match.group !== artifact.expectedState["group"]
        ) {
          verified = false;
        }
        if (
          artifact.expectedState["content"] !== undefined &&
          match.content !== artifact.expectedState["content"]
        ) {
          verified = false;
        }
      }

      return {
        ...artifact,
        observedState: {
          path: match.path,
          objectType: match.objectType,
          permissions: match.permissions,
          owner: match.owner,
          group: match.group,
          sizeBytes: match.sizeBytes,
        },
        verified,
        evidence: match.evidence,
      };
    }

    case "service": {
      const match = model.services.find((s) => s.name === artifact.identifier);
      if (!match) {
        return {
          ...artifact,
          observedState: null,
          verified: false,
          evidence: "UNKNOWN",
        };
      }
      let verified = true;
      if (artifact.expectedState) {
        if (
          artifact.expectedState["activeState"] &&
          match.activeState !== artifact.expectedState["activeState"]
        ) {
          verified = false;
        }
        if (
          artifact.expectedState["enabledState"] &&
          match.enabledState !== artifact.expectedState["enabledState"]
        ) {
          verified = false;
        }
      }
      return {
        ...artifact,
        observedState: {
          name: match.name,
          activeState: match.activeState,
          enabledState: match.enabledState,
        },
        verified,
        evidence: match.evidence,
      };
    }

    case "user": {
      const match = model.users.find((u) => u.username === artifact.identifier);
      if (!match) {
        return {
          ...artifact,
          observedState: null,
          verified: false,
          evidence: "UNKNOWN",
        };
      }
      return {
        ...artifact,
        observedState: {
          username: match.username,
          uid: match.uid,
          homeDirectory: match.homeDirectory,
          shell: match.shell,
        },
        verified: true,
        evidence: match.evidence,
      };
    }

    case "group": {
      const match = model.groups.find((g) => g.groupName === artifact.identifier);
      if (!match) {
        return {
          ...artifact,
          observedState: null,
          verified: false,
          evidence: "UNKNOWN",
        };
      }
      return {
        ...artifact,
        observedState: {
          groupName: match.groupName,
          gid: match.gid,
          members: match.members,
        },
        verified: true,
        evidence: match.evidence,
      };
    }

    case "package": {
      const match = model.packages.find((p) => p.packageName === artifact.identifier);
      const isInstalled = match ? match.installed : false;
      return {
        ...artifact,
        observedState: match ? { packageName: match.packageName, installed: match.installed, version: match.version } : null,
        verified: artifact.expectedState?.["installed"] !== undefined ? isInstalled === artifact.expectedState["installed"] : isInstalled,
        evidence: match ? match.evidence : "UNKNOWN",
      };
    }

    default:
      return artifact;
  }
}

export function evaluateArtifacts(
  artifacts: MissionArtifact[],
  model: CanonicalEnvironmentModel,
): MissionArtifact[] {
  return artifacts.map((artifact) => evaluateArtifactAgainstModel(artifact, model));
}
