# action-cache-api-shim

This action will let you use other actions/tools that need access to the legacy
GHA Cache Service v1 API.

It does that by running a shim v1 API server that proxies its requests and
responses to/from the new v2 API. The server is launched as a daemon and
`ACTIONS_CACHE_URL` environment variable is updated to its address. Any actions
that follow this one will proxy their requests through the shim.

If v2 Cache API is not available on the runner, this action is effectively a
no-op.

## Usage

```yaml
steps:
  - uses: jashandeep-sohi/action-cache-api-shim@v1

  # For docker:
  - name: Set up Docker Buildx
    uses: docker/setup-buildx-action@v3
    with:
      # This is needed so that Buildkit builders can access the server
      # from the container environment.
      driver-opts: |
        network=host

  - name: Build Container using Github Actions Cache
    uses: docker/build-push-action@v6
    with:
      push: false
      tags: user/app:latest
      cache-from: type=gha
      cache-to: type=gha,mode=max

  # For magic-nix-cache:
  - uses: DeterminateSystems/nix-installer-action@main
  - uses: DeterminateSystems/magic-nix-cache-action@v8
  - name: Run nix build
    run: |-
      nix build .
```

## Development

Enter the development shell.

If you have `direnv` installed, allow this repo if you haven't already:

```sh
direnv allow
```

Otherwise, you can enter it using:

```sh
nix develop --impure
```

Install dependencies:

```sh
pnpm install
```
