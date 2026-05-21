import { inferPrimaryPlatform, type ValidationIssue, type Validator } from "./core";

export const schemaMigrationValidator: Validator = {
    id: "task.schemaMigration",
    // Couples Prisma schema edits with versioned migration files. If schema.prisma
    // is touched in a backend phase, a sibling prisma/migrations/<ts>_<slug>/migration.sql
    // must also exist (either pre-existing in the repo or freshly written in this run).
    // Without this, schema changes ride along on the next deploy via `prisma db push`,
    // which silently drops/creates tables in production.
    //
    // Prior incident: VerificationCode rename shipped without a
    // migration; old EmailVerificationCode + PasswordResetToken tables persisted
    // in prod, password-reset endpoint 500'd until manual intervention.
    async run(workspace, manifest) {
      const platform = inferPrimaryPlatform(workspace);
      if (platform !== "backend") return [];

      const schemaTouched = manifest.changedFiles.some((f) =>
        /(?:^|\/)prisma\/schema\.prisma$/.test(f),
      );
      if (!schemaTouched) return [];

      const fs = await import("fs/promises");
      const path = await import("path");
      // If schema.prisma was removed as part of replacing a Prisma backend
      // with a different stack, there is no Prisma migration to generate.
      // This validator protects live Prisma schemas; it should not block
      // deliberate stack replacement work.
      try {
        await fs.access(path.join(workspace, "prisma", "schema.prisma"));
      } catch {
        return [];
      }
      // Detect either a freshly-written migration file (changed in this run)
      // OR a pre-existing migrations directory next to the schema (idempotent boot
      // workflows like `migrate deploy` are the standard).
      const freshMigration = manifest.changedFiles.some((f) =>
        /(?:^|\/)prisma\/migrations\/\d{4,}_[^/]+\/migration\.sql$/.test(f),
      );
      if (freshMigration) return [];

      const migrationsDir = path.join(workspace, "prisma", "migrations");
      let hasAnyMigration = false;
      try {
        const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
        hasAnyMigration = entries.some(
          (e) => e.isDirectory() && /^\d{4,}_/.test(e.name),
        );
      } catch {
        hasAnyMigration = false;
      }

      if (!hasAnyMigration) {
        return [{
          id: "task-schema-migration-missing",
          severity: "error",
          message: "prisma/schema.prisma changed but no prisma/migrations/<ts>_<slug>/migration.sql was generated. Run `npx prisma migrate dev --name describe_change` locally and commit the resulting migration directory. Production deploys via `prisma migrate deploy` and will not pick up schema-only edits.",
          files: ["prisma/schema.prisma"],
        }];
      }

      // Repo has migrations but this run only edited the schema. That's OK
      // for renames-without-data-impact only if the change is captured in a
      // freshly-baselined migration. Warn so a human sanity-checks.
      return [{
        id: "task-schema-migration-not-regenerated",
        severity: "warning",
        message: "schema.prisma changed but no new migration file was added in this run. If the diff requires SQL (rename, type change, new column), generate a migration with `prisma migrate dev` and commit it. If the change is documentation-only (comments), this warning is safe to ignore.",
        files: ["prisma/schema.prisma"],
      }];
    },
  };
