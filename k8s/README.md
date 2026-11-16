# Kubernetes deployment

Kustomize manifests for running God's Eye View on a Kubernetes cluster. The
`base/` folder is generic. Each environment is an overlay in `overlays/` that
sets its own image, public hostname and routing.

```
k8s/
├── base/                 Deployment and ClusterIP Service, no environment data
└── overlays/<env>/       One folder per environment: image, hostname, routing
```

## What the base provides

- One replica, `Recreate` strategy. State lives on the container filesystem,
  so two pods must never write it at once.
- Runs as non-root uid 1000, with privilege escalation disabled and all
  capabilities dropped.
- Port 4173, with startup, readiness and liveness probes on `/`.
- An optional Secret, `gev-provider-keys`, for provider API keys (see below).
- A ClusterIP Service only. Expose the app through your own ingress or
  gateway, never a LoadBalancer: the server brokers provider API keys.

The base image is a placeholder (`ghcr.io/OWNER/gods-eye-view`). An overlay
must set the real image before the base will deploy.

## 1. Build the image

The `Docker image` workflow (`.github/workflows/docker-publish.yml`) builds
`Dockerfile.prod` and pushes it to `ghcr.io/<owner>/<repo>` on each push to
`main` and on `v*` tags. It uses the built-in `GITHUB_TOKEN`, so a fork
publishes to its own namespace.

Each build is tagged `sha-<short-commit>`. Pin that tag in your overlay so
redeploys are reproducible. Make the package public, or give the cluster an
image pull secret.

## 2. Create an overlay

Copy an existing overlay (or start from this layout) and set the image and
hostname:

```yaml
# overlays/<env>/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: <env-namespace>

resources:
  - ../../base
  # your ingress / gateway routing goes here, for example a VirtualService

images:
  - name: ghcr.io/OWNER/gods-eye-view
    newName: ghcr.io/<owner>/gods-eye-view
    newTag: sha-<short-commit>

patches:
  - path: deployment-patch.yaml
```

```yaml
# overlays/<env>/deployment-patch.yaml
# The app rejects Host headers it does not know. Set this to the public hostname.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gods-eye-view
spec:
  template:
    spec:
      containers:
        - name: gods-eye-view
          env:
            - name: GEV_ALLOWED_HOSTS
              value: <public-hostname>
```

## 3. Provide provider API keys

Keys are read from the `gev-provider-keys` Secret, which is **not** managed by
kustomize. Create it in the target namespace and keep it out of git:

```bash
# keys.env holds lines such as OPENAI_API_KEY=... and GEMINI_API_KEY=...
kubectl -n <env-namespace> create secret generic gev-provider-keys \
  --from-env-file=keys.env
rm keys.env
```

Names come from `.env.example`. Set only the keys you use. The pod starts
without the Secret, but the features that need keys will be unavailable.

To rotate a key, recreate the Secret (add `--dry-run=client -o yaml | kubectl
apply -f -`) and restart the pod:

```bash
kubectl -n <env-namespace> rollout restart deployment/gods-eye-view
```

## 4. Deploy

```bash
kubectl apply -k k8s/overlays/<env>
kubectl -n <env-namespace> rollout status deployment/gods-eye-view
```

Check the pod is running and the Secret is attached:

```bash
kubectl -n <env-namespace> get pods -l app.kubernetes.io/name=gods-eye-view
kubectl -n <env-namespace> exec deploy/gods-eye-view -- sh -c 'test -n "$OPENAI_API_KEY" && echo set'
```

## Access without a gateway

For a quick local check that skips the ingress:

```bash
kubectl -n <env-namespace> port-forward svc/gods-eye-view 4173:80
```

Then open `http://localhost:4173`.

## Known limitations

- **Forwarding headers block sensitive routes.** The app refuses requests that
  carry reverse-proxy headers (`X-Forwarded-For`, `X-Forwarded-Proto`,
  `X-Forwarded-Host`, `Forwarded`, `Via`, and similar) on the realtime token
  (voice) and typed chat routes, and on Provider Settings. Ingress and gateway
  layers add these headers, so voice and chat will fail through them. The
  options are to strip the headers at the mesh, or to change the gate in code.
  See `SECURITY.md` before changing the gate.
- **Provider Settings is local-only.** The in-app key panel only accepts
  loopback requests, so set keys through the Secret.
- **No persistence.** Anything written to the container (including keys set
  in the in-app panel) is lost on pod restart or redeploy.
- **Single replica.** Do not scale above one replica.
- **Keys are server-side only.** `OPENAI_API_KEY`, `GEMINI_API_KEY` and
  similar keys never reach the browser. `GOOGLE_MAPS_API_KEY`,
  `CESIUM_ION_TOKEN` and `MAPILLARY_CLIENT_TOKEN` are sent to the browser by
  design, so restrict them in the provider's console.
