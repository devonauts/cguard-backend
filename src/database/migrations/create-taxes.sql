-- Migration: Create taxes table
-- Date: 2026-01-06

CREATE TABLE IF NOT EXISTS "taxes" (
  "id" CHAR(36) PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "rate" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "tenantId" CHAR(36) NOT NULL,
  "createdById" CHAR(36),
  "updatedById" CHAR(36),
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS taxes_tenantId_idx ON "taxes" ("tenantId");
