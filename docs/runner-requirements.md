# Self-hosted runner requirements — `ovms-link` plugin publisher

Requirements for the GitHub Actions self-hosted runner that
`.github/workflows/publish-plugin-repo.yml` uses to build the OVMS plugin repo and
publish it to the `ovms-plugins` nginx pod on the Slate Hill K3s cluster. Hand this
to whatever provisions/manages the runner. See also `docs/plugin-repo-hosting.md`.

> **Provisioned as:** the `ovms-link-publish` **ARC** (Actions Runner Controller)
> scale set on the Slate Hill K3s cluster — managed in the infrastructure repo at
> `slate-hill/configs/k3s/arc/ovms-link-runner-set-values.yaml`. Because ARC's
> `gha-runner-scale-set` matches jobs by the **scale-set name** (not `self-hosted` +
> label arrays), the workflow uses `runs-on: ovms-link-publish`, and `kubectl` is
> baked into the runner image rather than pre-installed on a host. The
> platform/software/egress requirements below still describe what the runner
> environment must provide.

## Registration

| Field | Value |
|---|---|
| Scope | Repo-level runner for **`github.com/kezarjg/ovms-link`** |
| Job targeting | ARC `gha-runner-scale-set` — the job uses `runs-on: ovms-link-publish` (the scale-set name). ARC does **not** support `self-hosted` + label-array matching. |
| Runner group | Default (repo) unless you standardize on groups |
| Lifecycle | Persistent **or** ephemeral both work — the job holds no cross-run state. Persistent is slightly cheaper (keeps the Node tool-cache warm; ephemeral re-downloads Node each run) |
| Concurrency | One runner suffices — the workflow sets `concurrency: publish-plugin-repo`, so GitHub serializes publishes. Extra runners with the label are harmless |

## Platform

- **Linux, x86_64.**
- **GNU coreutils** (the workflow uses `base64 -d` and the setup snippet uses
  `base64 -w0`; BSD/macOS `base64` differs — must be GNU).
- **bash** as the shell.
- Runs fine as a **non-root** service user — the job needs no root, no sudo, no Docker.
- Disk: a few hundred MB free is ample (repo is small, Node ~tens of MB, plugin tree
  is 92 KB). Default `_work` dir.

## Software that must be on `PATH`

| Tool | Why | Notes |
|---|---|---|
| `kubectl` | The job runs `kubectl get/exec/cp` against the cluster | Version within +/-1 minor of the cluster (**v1.34**), so 1.33-1.35. **No pre-existing kubeconfig needed** — the job supplies a scoped one at runtime. |
| `git` | `actions/checkout` clones the repo | Any recent version |
| Node.js | Build + tests | **Not required pre-installed** — `actions/setup-node@v4` provisions Node 22 (per `.nvmrc`). Pre-installing Node 22 only saves the per-run download. |

No `npm install` happens (the project has **0 runtime deps**; build + tests are
dependency-free), so no registry access is needed for dependencies.

## Network egress

Two destinations, both required:

1. **GitHub Actions egress** (standard): `github.com`, `api.github.com`,
   `*.actions.githubusercontent.com`, `codeload.github.com`,
   `objects.githubusercontent.com`, and GitHub release assets (for
   `actions/checkout`, `actions/setup-node`, and the Node download). Standard
   hosted-runner allowlist applies.
2. **K3s API server: `tcp/6443` to `10.20.5.20`.** This is the entire reason the
   runner is self-hosted. `kubectl cp`/`exec` stream **through the API server**, so
   you only need reachability to `6443` — **not** to the pod CIDR or any node directly.

**Not required:** reachability to `http://ovms.kezarnet.com`. The publish
verification reads `plugins.rev` back **from the pod via `kubectl exec`**, not over
the public URL — so no dependency on the public hostname or LAN hairpin.

## Secrets / credentials on the box

- **None at rest.** The cluster credential is delivered as the GitHub repo secret
  `OVMS_KUBECONFIG` at job time, written to `$RUNNER_TEMP/kubeconfig`, and used only
  for that job. The box stores no long-lived cluster credentials — a deliberate
  least-privilege posture.
- The runner registration token/PAT is whatever your management instance already uses.

## What a job actually executes (for allow-listing / review)

1. `actions/checkout` -> git clone
2. `actions/setup-node` -> fetch Node 22
3. `npm test` -> `node build.js ...` then `node --test ...` (no network, no install)
4. `node publish.js --out ./plugins` -> writes the static tree locally
5. `base64 -d` the `OVMS_KUBECONFIG` secret -> `$RUNNER_TEMP/kubeconfig`
6. `kubectl get pod` / `kubectl exec rm` / `kubectl cp` / `kubectl exec cat` against
   `10.20.5.20:6443` (namespace `ovms` only, via a ServiceAccount scoped to `pods`
   read + `pods/exec`)

## Acceptance check

Runner shows **Idle** with labels `self-hosted, sh-k3s` in the repo's
Actions -> Runners, and from the box: `nc -vz 10.20.5.20 6443` succeeds and
`kubectl version --client` prints a 1.33-1.35 client.
