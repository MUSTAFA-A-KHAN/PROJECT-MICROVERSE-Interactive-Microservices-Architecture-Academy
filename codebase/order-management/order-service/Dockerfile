# syntax=docker/dockerfile:1.7
# ---- Stage 1: build a static binary ------------------------------------------
FROM golang:1.26-alpine AS builder
WORKDIR /src

# Dependencies first: this layer is cached until go.mod/go.sum change.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod     --mount=type=cache,target=/root/.cache/go-build     CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/server

# ---- Stage 2: minimal runtime ------------------------------------------------
# distroless/static: CA certificates and tzdata, no shell, no package manager.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/app /app
EXPOSE 8082
USER nonroot:nonroot
ENTRYPOINT ["/app"]
