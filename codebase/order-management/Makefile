SERVICES := api-gateway user-service order-service notification-service

.PHONY: up down logs build test vet tidy smoke clean

up:            ## Build and start the whole system
	@test -f .env || cp .env.example .env
	docker compose up --build -d
	@echo "Gateway: http://localhost:8080   RabbitMQ UI: http://localhost:15672"

down:          ## Stop containers (keeps database volumes)
	docker compose down

clean:         ## Stop containers AND delete all data volumes
	docker compose down -v

logs:          ## Follow logs from every service
	docker compose logs -f --tail=50

build test vet tidy:
	@for s in $(SERVICES); do echo "==> $$s: go $@"; (cd $$s && go $(if $(filter tidy,$@),mod tidy,$@ ./...)) || exit 1; done

smoke:         ## Register, log in, place an order (twice, same Idempotency-Key)
	@./scripts/smoke.sh
