-- users is owned exclusively by the User Service.
-- Other services reference users by id only, never with a foreign key,
-- because their data lives in a different database.
CREATE TABLE users (
    id            BIGSERIAL    PRIMARY KEY,
    email         TEXT         NOT NULL,
    name          TEXT         NOT NULL,
    password_hash TEXT         NOT NULL,
    role          TEXT         NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    status        TEXT         NOT NULL DEFAULT 'active'   CHECK (status IN ('active', 'suspended')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Emails are normalised to lower case by the service; the unique index is the
-- race-free guarantee that two registrations cannot claim the same address.
CREATE UNIQUE INDEX users_email_key ON users (email);
