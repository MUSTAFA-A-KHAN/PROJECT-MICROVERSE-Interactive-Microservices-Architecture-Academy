-- Owned exclusively by the Order Service.
CREATE TABLE orders (
    id           BIGSERIAL    PRIMARY KEY,
    -- user_id is NOT a foreign key: users live in another service's database.
    user_id      BIGINT       NOT NULL,
    status       TEXT         NOT NULL
                 CHECK (status IN ('PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
    total_cents  BIGINT       NOT NULL CHECK (total_cents >= 0),
    currency     CHAR(3)      NOT NULL,
    version      INTEGER      NOT NULL DEFAULT 1,      -- optimistic concurrency
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Serves "my orders, newest first" with keyset pagination.
CREATE INDEX orders_user_id_id_idx ON orders (user_id, id DESC);

CREATE TABLE order_items (
    order_id         BIGINT   NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id       TEXT     NOT NULL,
    quantity         INTEGER  NOT NULL CHECK (quantity > 0),
    unit_price_cents BIGINT   NOT NULL CHECK (unit_price_cents >= 0),
    PRIMARY KEY (order_id, product_id)
);

-- Transactional outbox: events are inserted in the same transaction as the
-- state change and published asynchronously by the relay.
CREATE TABLE outbox (
    id            BIGSERIAL    PRIMARY KEY,               -- publish order
    event_id      UUID         NOT NULL UNIQUE,           -- consumers dedupe on this
    event_type    TEXT         NOT NULL,                  -- routing key, e.g. order.created
    aggregate_id  BIGINT       NOT NULL,
    payload       JSONB        NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);

-- Partial index: the relay only ever scans unpublished rows, which stay few.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Idempotency keys make POST /v1/orders safe to retry.
CREATE TABLE idempotency_keys (
    user_id       BIGINT       NOT NULL,
    key           TEXT         NOT NULL,
    request_hash  TEXT         NOT NULL,
    order_id      BIGINT       REFERENCES orders (id),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);
