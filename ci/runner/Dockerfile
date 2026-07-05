# Runner image for the `ovms-link-publish` ARC scale set on the Slate Hill K3s
# cluster (see infrastructure/slate-hill/configs/k3s/arc/ovms-link-runner-set-values.yaml).
#
# Stock GitHub Actions runner (non-root `runner` user; already has git + tar, the
# latter needed for `kubectl cp`) + kubectl pinned to the cluster's minor (v1.34).
# Node is NOT baked in — actions/setup-node provisions Node 22 per-job from .nvmrc.
ARG RUNNER_VERSION=latest
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}

# Cluster is v1.34.x; keep kubectl within +/-1 minor (1.33-1.35).
ARG KUBECTL_VERSION=v1.34.4
USER root
RUN curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
 && chmod 0755 /usr/local/bin/kubectl \
 && kubectl version --client
USER runner
