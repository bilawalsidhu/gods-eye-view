- Start the Docker install on SELinux hosts such as Fedora and RHEL. Compose now
  mounts the checkout with `:z`; without it the container could not read `/app`
  and stopped with "Cannot find module '/app/scripts/docker-start.mjs'"
  (Anıl Güvenç, @anilguvenc, #1391).
