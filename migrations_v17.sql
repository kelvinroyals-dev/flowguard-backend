-- Migration v17: ticket columns (idempotent) + conversation thread (replies)

-- Ensure client-facing ticket columns exist (may have been added earlier)
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS subject VARCHAR(255),
  ADD COLUMN IF NOT EXISTS category VARCHAR(50),
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS property_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS user_id INT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS ticket_messages (
  id BIGSERIAL PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  author_type VARCHAR(20) NOT NULL DEFAULT 'client' CHECK (author_type IN ('client','support','system')),
  author_name VARCHAR(255),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at ASC);
