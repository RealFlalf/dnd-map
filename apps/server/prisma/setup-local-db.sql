-- One-time setup for a locally installed PostgreSQL (run as the postgres superuser):
--   psql -U postgres -f apps/server/prisma/setup-local-db.sql
-- CREATEDB is required by `prisma migrate dev`, which creates a temporary shadow database.
CREATE ROLE dnd_map WITH LOGIN PASSWORD 'dnd_map' CREATEDB;
CREATE DATABASE dnd_map OWNER dnd_map;
