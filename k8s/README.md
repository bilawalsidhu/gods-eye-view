# Deploy God's Eye View on Kubernetes

Everything is in one file, [`gods-eye-view.yaml`](gods-eye-view.yaml). You do
not need Kustomize or Helm.

You need `kubectl` pointed at your cluster, and a container image of the app.

## 1. Get an image

The repository has a GitHub Actions workflow
(`.github/workflows/docker-publish.yml`). It builds the app and publishes it to
GitHub Container Registry under your account, each time a GitHub release is
published:

1. Fork the repository on GitHub.
2. On your fork, go to **Releases** → **Draft a new release**, create a tag
   such as `v1.0.0`, and publish the release.
3. The **Docker image** workflow runs on the **Actions** tab. When it finishes,
   the image is at `ghcr.io/<your-github-name>/gods-eye-view` with the tags
   `v1.0.0`, `1.0`, `latest` and `sha-<commit>`. Make the package public under
   the repository's **Packages** settings, or give the cluster a pull secret.

## 2. Edit the file

Open `gods-eye-view.yaml` and change two things, marked `CHANGE THIS`:

- `image:` the image from step 1, for example
  `ghcr.io/your-github-name/gods-eye-view:latest`.
- `GEV_ALLOWED_HOSTS` the hostname you will open the app at. Keep `localhost`
  if you will use port-forward.

## 3. Add your API keys (optional)

Keys such as `OPENAI_API_KEY` are read from a Secret. Put them in a file
called `keys.env`, one per line:

```
OPENAI_API_KEY=sk-...
```

Then create the Secret, and delete the file:

```bash
kubectl create secret generic gev-provider-keys --from-env-file=keys.env
rm keys.env
```

Names come from `.env.example` in the repository. Only add the keys you use.
The app starts without the Secret, but features that need a key stay off.

To change a key later, delete the Secret and create it again, then restart:

```bash
kubectl delete secret gev-provider-keys
kubectl create secret generic gev-provider-keys --from-env-file=keys.env
kubectl rollout restart deployment/gods-eye-view
```

## 4. Deploy

```bash
kubectl apply -f k8s/gods-eye-view.yaml
kubectl rollout status deployment/gods-eye-view
```

Add `-n <namespace>` to both commands if you use a namespace.

## 5. Open the app

For a quick local check, forward the port and open the address in your browser:

```bash
kubectl port-forward svc/gods-eye-view 4173:80
```

Then open `http://localhost:4173`. The forward stops when you close the
terminal.

To reach the app through your own ingress or gateway, route its hostname to the
`gods-eye-view` Service on port 80, and set `GEV_ALLOWED_HOSTS` to that hostname.

## Known limitations

- **Voice and chat through a gateway.** The app refuses requests that carry
  proxy headers (`X-Forwarded-For`, `X-Forwarded-Proto` and similar) on the
  voice token, typed chat and Provider Settings routes. Gateways add those
  headers, so voice and chat fail through them. Port-forward works. See
  `SECURITY.md` before changing this.
- **Provider Settings is local-only.** The in-app key panel only accepts
  requests from the pod's own machine. Set keys with the Secret instead.
- **No persistence.** Anything the app writes to its container is lost when the
  pod restarts or is redeployed.
- **One copy only.** Keep `replicas: 1`.
- **Browser-side keys.** `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN` and
  `MAPILLARY_CLIENT_TOKEN` are sent to the browser by design. Restrict them in
  the provider's console. Keys such as `OPENAI_API_KEY` stay on the server.
