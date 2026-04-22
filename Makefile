.PHONY: help install dev test typecheck db-up db-down db-push db-migrate seed smoke \
        settle build docker-build docker-run validate-registry check

# Auto-detect bun; fall back to bun via npx if not in PATH.
BUN ?= $(shell command -v bun 2>/dev/null || echo "bunx")

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	$(BUN) install

dev: ## Run the server with watch mode
	$(BUN) run dev

test: ## Run unit + integration tests
	$(BUN) test

typecheck: ## Run TypeScript in no-emit mode
	$(BUN) run typecheck

db-up: ## Start local Postgres + Redis (docker compose)
	docker compose up -d

db-down: ## Stop local Postgres + Redis
	docker compose down

db-push: ## Push schema to DB (dev — uses drizzle-kit push, non-versioned)
	$(BUN) run db:push

db-migrate: ## Apply versioned migrations in drizzle/
	$(BUN) run db:migrate

seed: ## Seed a demo user with $25 wallet
	$(BUN) run seed

smoke: ## Run scripts/smoke-test.sh against the local server (needs AXON_KEY)
	bash scripts/smoke-test.sh

settle: ## Run settlement once (yesterday)
	$(BUN) run settle

build: ## Build the Bun bundle
	$(BUN) run build

docker-build: ## Build the production Docker image
	docker build -t axon:dev .

docker-run: ## Run the production image locally
	docker run --rm -p 3000:3000 --env-file .env axon:dev

validate-registry: ## Lint every registry/*.json for required fields
	@for f in registry/*.json; do \
	  echo "Checking $$f"; \
	  jq -e '.slug and .provider and .category and .base_url and .auth.type and (.endpoints | length > 0)' "$$f" > /dev/null; \
	done
	@echo "✓ registry validated"

check: typecheck test validate-registry ## Run all pre-commit checks
	@echo "✓ all checks passed"
