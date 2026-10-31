# Order Management System

The reference system for the Microverse course: four independently deployable
Go services, each with its own module, Dockerfile and (where it stores data)
its own PostgreSQL database.

| Service | Port | Owns | Talks to |
|---|---|---|---|
| `api-gateway` | 8080 (public) | nothing (stateless) | Redis (rate limits), user-service, order-service |
| `user-service` | 8081 | `users-db` | Redis (profile cache) |
| `order-service` | 8082 | `orders-db` (orders, items, outbox, idempotency keys) | user-service (sync), RabbitMQ (via outbox) |
| `notification-service` | 8083 (health only) | — | RabbitMQ (consumer), Redis (dedupe) |

## Run it

Requires Docker with Compose v2.

```bash
cp .env.example .env        # then edit JWT_SECRET
docker compose up --build   # or: make up
./scripts/smoke.sh          # register → login → order twice (idempotent) → cancel
```

- Gateway: http://localhost:8080/api/v1/…
- RabbitMQ management UI: http://localhost:15672 (credentials from `.env`)

## Develop

Each service is its own Go module (Go 1.26):

```bash
make build   # go build ./... in every service
make test    # unit tests (breaker state machine, idempotent order creation)
make vet
```

## Things to try

- `docker compose stop user-service`, then create an order: the gateway returns
  503 after Order Service's retries and circuit breaker give up.
- `docker compose stop rabbitmq`, create orders, then start it again: events wait
  in the `outbox` table and are published when the broker returns.
- Send the same `POST /api/v1/orders` twice with one `Idempotency-Key`: the
  second response carries `Idempotent-Replayed: true` and the same order ID.

## Layout

```
api-gateway/           cmd/gateway, internal/{config,proxy,breaker,identity}, middleware/
user-service/          cmd/server, internal/{config,model,repository,service,handler,cache,middleware,reqctx}, migrations/
order-service/         cmd/server, internal/{config,model,repository,service,handler,client,events,middleware,reqctx}, migrations/
notification-service/  cmd/worker, internal/consumer
deploy/k8s/            Deployment, Service, HPA, PDB, ConfigMap, Secret, Ingress, NetworkPolicy
```
