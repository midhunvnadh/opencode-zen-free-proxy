# Platforms

## Before you start

- Only needed to publish an image for other people to pull. Running it locally,
  `compose.yaml` already builds the image for your machine.
- A registry and a tag you can push to — `youruser/oc-proxy` in the command
  below is a placeholder for it.
- buildx (`docker buildx version`). Building for a foreign architecture is
  emulated, so it is slow.
- If you only need to know whether *this* machine is supported, the answer is
  almost always yes: read [Supported](#supported) and stop there.

## Supported

linux/amd64 and linux/arm64, both musl. Both are built and tested. Anything else
fails at the first `FROM`:

```
no match for platform in manifest: not found
```

That pair is a ceiling rather than a choice: `oven/bun:1-alpine` publishes only
those two, and `@opencode/cli` ships binaries only for linux `x64` and `arm64`.
`x64-baseline` covers CPUs without AVX2, and the postinstall picks it
automatically.

`compose.yaml` builds for whatever architecture it runs on, so a MacBook on
arm64 gets an arm64 image with no extra flags.

CI builds both of these on every push to `main` and `dev`, so the list above is
kept honest automatically — see [development.md](development.md).

## Publishing one multi-arch tag

Build each platform and merge the manifests with buildx:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t youruser/oc-proxy .
```