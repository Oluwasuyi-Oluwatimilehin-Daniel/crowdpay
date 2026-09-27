-- Add contributor privacy preference to users table
-- Allows contributors to control visibility of their name, wallet, amounts, and timing on public campaign surfaces

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'contributor_privacy') THEN
    CREATE TYPE contributor_privacy AS ENUM ('full', 'amount_only', 'anonymous');
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS contributor_privacy contributor_privacy DEFAULT 'full';

-- Default to 'full' to maintain current behavior for existing contributors
-- This ensures existing data presentation doesn't change silently
