# Operating the second brain. Every target is safe to run twice.
#
# Nothing here writes a secret to stdout except `kek`, which exists to
# generate one, and `psql`, which opens a shell into the database.

COMPOSE ?= docker compose
SERVICE ?= brain

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: kek
kek: ## Print a fresh AGENTX_BRAIN_KEK (32 bytes, base64)
	@openssl rand -base64 32

# Hex, not base64, and that is the whole point. This value goes inside
# AGENTX_BRAIN_DATABASE_URL, where base64's `/` and `+` — and any `@` a person
# picks by hand — break the URL. A password containing `@` makes asyncpg read
# the rest of it as the hostname, and the service then fails with "Name or
# service not known", which looks like a network fault and is not one.
# 0-9a-f needs no encoding, ever.
.PHONY: pw
pw: ## Print a URL-safe POSTGRES_PASSWORD (32 bytes, hex)
	@openssl rand -hex 32

.PHONY: up
up: ## Build and start everything
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop everything, keeping the database volume
	$(COMPOSE) down

.PHONY: logs
logs: ## Follow the service's logs
	$(COMPOSE) logs -f $(SERVICE)

.PHONY: health
health: ## Ask the running service how it is
	$(COMPOSE) exec $(SERVICE) curl -fsS http://127.0.0.1:8811/health

.PHONY: config
config: ## Validate the compose file (what CI runs)
	$(COMPOSE) --env-file .env.example config --quiet

.PHONY: psql
psql: ## Open a psql shell on the service's database
	$(COMPOSE) exec postgres psql -U brain -d brain

.PHONY: backup
backup: ## Dump the database to backup-<UTC timestamp>.sql
	$(COMPOSE) exec -T postgres pg_dump -U brain -d brain \
		> "backup-$$(date -u +%Y%m%dT%H%M%SZ).sql"
	@echo "Wrote backup-*.sql. It contains every person's encrypted model key"
	@echo "and their conversation history. Store it accordingly."

.PHONY: restore
restore: ## Restore from FILE=backup-....sql (see README before running)
	@test -n "$(FILE)" || { echo "usage: make restore FILE=backup-....sql"; exit 2; }
	$(COMPOSE) exec -T postgres psql -U brain -d brain < "$(FILE)"
	@echo
	@echo "Restored. READ THIS: any client whose sync cursor is above the"
	@echo "restored doc_seq will silently pull nothing, forever. Reset those"
	@echo "clients' cursors to 0 — re-pulling everything is safe, because"
	@echo "applying a document twice is a no-op."

.PHONY: test-db
test-db: ## Start a throwaway Postgres for `pytest tests/second_brain`
	@docker rm -f agentx-brain-test-db >/dev/null 2>&1 || true
	@docker run -d --rm --name agentx-brain-test-db \
		-e POSTGRES_PASSWORD=brain -e POSTGRES_USER=brain -e POSTGRES_DB=brain \
		-p 127.0.0.1:55433:5432 --tmpfs /var/lib/postgresql/data \
		postgres:17.9-alpine >/dev/null
	@echo "export AGENTX_BRAIN_TEST_DSN=postgresql://brain:brain@127.0.0.1:55433/brain"

.PHONY: test-db-stop
test-db-stop: ## Stop the throwaway test Postgres
	@docker rm -f agentx-brain-test-db >/dev/null 2>&1 || true
