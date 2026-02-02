# Contributing to Recommend Backend

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

### Prerequisites
- Node.js `lts/*` or later
- Yarn package manager
- Git

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/recommend-be.git
   cd recommend-be
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feat/your-feature-name
   ```

3. **Install dependencies**
   ```bash
   yarn install
   ```

4. **Setup environment variables**
   ```bash
   cp .env.example .env
   ```

5. **Start development server**
   ```bash
   yarn start:dev
   ```

## Development Workflow

### Branch Naming
- `feat/` — New features
- `fix/` — Bug fixes
- `docs/` — Documentation updates
- `refactor/` — Code refactoring
- `test/` — Adding tests
- `chore/` — Maintenance tasks

**Example:** `feat/user-authentication`, `fix/database-connection`

### Code Style

We use **ESLint** and **Prettier** for code consistency.

1. **Run linting**
   ```bash
   yarn lint
   ```

2. **Format code**
   ```bash
   yarn format
   ```

3. **Build**
   ```bash
   yarn build
   ```

4. **Run tests**
   ```bash
   yarn test
   ```

### Commit Messages

Follow conventional commit format:

```
feat: add JWT authentication
fix: resolve database connection leak
docs: update API documentation
refactor: simplify user service logic
test: add unit tests for auth guard
chore: update dependencies
```

## Testing

- Unit tests: `yarn test`
- Watch mode: `yarn test:watch`
- Coverage: `yarn test:cov`
- E2E tests: `yarn test:e2e`

Add tests for any new features or bug fixes in `**/*.spec.ts` files.

## Pull Requests

1. **Keep PRs focused** — One feature or fix per PR
2. **Write descriptive titles** — Use conventional commit format
3. **Fill out the PR template** — Provide context and rationale
4. **All checks must pass:**
   - `lintExpected` ✓
   - `buildExpected` ✓
   - `testExpected` ✓

## Project Structure

```
src/
├── common/         # Shared utilities, guards, filters, exceptions
├── config/         # Environment and database configuration
├── database/       # TypeORM migrations
├── modules/        # Feature modules (auth, users, products, etc.)
├── app.module.ts   # Root module
└── main.ts         # Entry point
```

Each module follows this structure:
```
modules/auth/
├── auth.controller.ts
├── auth.service.ts
├── auth.module.ts
├── dto/            # Data Transfer Objects
├── entities/       # TypeORM entities
├── guards/         # Auth guards
└── strategies/     # Passport strategies
```

## Database Migrations

1. **Generate migration**
   ```bash
   yarn migration:generate --name YourMigrationName
   ```

2. **Run migrations**
   ```bash
   yarn migration:run
   ```

3. **Revert migrations**
   ```bash
   yarn migration:revert
   ```

## Branches

- `development` — Active development, receives all PRs
- `staging` — Pre-production testing, deployed to Render
- `main` — Production-ready code, deployed to Heroku

### Branch Protection Rules

All branches require:
- ✅ lintExpected
- ✅ buildExpected
- ✅ testExpected
- PR review approval

## CI/CD Pipeline

### Workflows
- **CI** (on `development`): Lint → Build → Test
- **CD - Staging** (on `staging`): Build → Test → Deploy to Render
- **CD - Production** (on `main`): Build → Test → Deploy to Heroku

All checks run automatically on push and PR.

## Code Review Guidelines

When reviewing code, consider:
- Does it follow the project structure?
- Are there tests for new functionality?
- Is error handling appropriate?
- Are environment variables documented?
- Does it maintain backward compatibility?

## Reporting Issues

Use GitHub Issues with clear titles:
- `[BUG]` — For bugs
- `[FEATURE]` — For feature requests
- `[DOCS]` — For documentation improvements

Include:
- What happened
- Expected behavior
- Steps to reproduce (for bugs)
- Environment details

## Questions?

- Check existing issues/PRs
- Review the [README.md](README.md)
- Open a discussion in Issues

Thank you for contributing! 🚀
