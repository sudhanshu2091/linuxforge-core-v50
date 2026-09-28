# LinuxForge Core — Environment Intelligence Subsystem (Pass 1A)

## Architecture Overview

The Environment Intelligence layer provides an authoritative, provider-neutral foundation for observing and representing actual Linux/Kali VM runtime state. It enforces deterministic observation and strict separation from learner action classification.

```
Browser
  ↓
Server Application
  ↓
Authorization Boundary
  ↓
Environment Intelligence (EnvironmentObserver)
  ↓
SandboxProvider Abstraction (real-linux-isolated-v1 / mock-modelled-v1)
  ↓
Runtime Node (QEMU / Isolated Kali ARM64)
  ↓
Observation Normalization & Evidence Classification
  ↓
Immutable Environment Snapshot & Delta Analysis
```

## Core Evidence Semantics

Every environmental fact carries an explicit `EvidenceLevel`:
1. `OBSERVED_FACT`: Directly extracted from real runtime execution/inspection inside the guest.
2. `STRONG_INFERENCE`: Deterministically derived from multiple observed facts or immutable container/VM descriptors.
3. `POSSIBLE_INTERPRETATION`: Plausible heuristic deduction (never used for deterministic mission verification or security gates).
4. `UNKNOWN`: Insufficient evidence or uninspected state (never converted into fake default values).

## Components Implemented

1. **Canonical Environment Model (`src/lib/forge/environment/types.ts`)**:
   - `EnvironmentIdentity`: Guest name, distribution, guestVersion, expectedArtifactRelease, kernel, architecture, shell, privilege state, and evidence level.
   - `EnvironmentUser` & `EnvironmentGroup`: Linux user accounts, UIDs/GIDs, shells, sudo capability, and group memberships.
   - `EnvironmentFilesystemObject`: File and directory paths, octal permissions, owners, groups, byte sizes, content, truncation flags.
   - `EnvironmentProcess`: PIDs, PPIDs, commands, states, users.
   - `EnvironmentService`: Systemd services, active and enabled states.
   - `EnvironmentPackage`: Package manager, package name, version, installation status.
   - `EnvironmentNetwork`: Active listeners and network isolation status.
   - `EnvironmentVariables`: Safe variables and redacted sensitive keys.
   - `EnvironmentRuntimeMetadata`: Provider capabilities, resource policies, and security invariants.

2. **Normalization Engine (`src/lib/forge/environment/normalization.ts`)**:
   - Maps raw provider responses into canonical environment structures.
   - Correctly identifies version discrepancies (e.g. expected artifact `2026.2` vs guest `2026.1`) without masking.

3. **Snapshots & Delta Engine (`src/lib/forge/environment/snapshots.ts`)**:
   - Deep-frozen, immutable snapshot structures.
   - High-precision snapshot diffing detecting file creation, modification, permission change, ownership change, process launch/termination, and service state transitions.

4. **Mission Artifact Tracking (`src/lib/forge/environment/artifacts.ts`)**:
   - Evaluates mission-targeted artifacts (files, services, permissions) against environment models.

5. **Observer Service (`src/lib/forge/environment/observer.server.ts`)**:
   - Coordinates targeted and full observations over `SandboxProvider`.
   - Never exposes host resources, credentials, or monitor sockets.

## Package Observation Pipeline

Provider-neutral package observation follows the strict boundary:

```
EnvironmentObserver.observePackages(handle, packageNames)
    ↓
SandboxProvider.getPackageState(handle, packageNames)
    ↓
[real-linux-isolated-v1]            [mock-modelled-v1]
    ↓                                   ↓
POST /v1/environments/:id/packages  deterministic package list
    ↓
Guest dpkg-query via isolated SSH
    ↓
PackageState { supported, packageManager, packages }
    ↓
normalizePackages() -> EnvironmentPackage[]
```
