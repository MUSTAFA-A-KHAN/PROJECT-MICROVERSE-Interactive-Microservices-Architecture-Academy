#!/usr/bin/env bash
# End-to-end smoke test against a running `docker compose up`.
# Registers a user, logs in, creates an order twice with the same
# Idempotency-Key (the second call must return the same order), then cancels it.
set -euo pipefail
API=${API:-http://localhost:8080/api/v1}
EMAIL="ada+$RANDOM@example.com"
KEY=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)

echo "==> register $EMAIL"
curl -fsS -X POST "$API/users" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"name\":\"Ada Lovelace\",\"password\":\"correct-horse-battery\"}" >/dev/null

echo "==> login"
TOKEN=$(curl -fsS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"correct-horse-battery\"}" | sed -E 's/.*"access_token":"([^"]+)".*/\1/')

order() {
  curl -fsS -X POST "$API/orders" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $KEY" -D - \
    -d '{"currency":"USD","items":[{"product_id":"sku-42","quantity":2,"unit_price_cents":2100}]}'
}
echo "==> create order"
FIRST=$(order)
echo "==> retry with the same Idempotency-Key"
SECOND=$(order)
echo "$SECOND" | grep -qi '^Idempotent-Replayed: true' && echo "    replayed: OK (no duplicate order)"

ID=$(echo "$FIRST" | tail -n1 | sed -E 's/.*"id":([0-9]+).*/\1/')
echo "==> get order $ID"
curl -fsS "$API/orders/$ID" -H "Authorization: Bearer $TOKEN"; echo
echo "==> cancel order $ID"
curl -fsS -X POST "$API/orders/$ID/cancel" -H "Authorization: Bearer $TOKEN"; echo
echo "==> done. Check notification-service logs for two emails:  docker compose logs notification-service"
