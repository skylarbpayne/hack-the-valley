CREATE TABLE IF NOT EXISTS physical_resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  inventory_code TEXT UNIQUE,
  asset_tag TEXT UNIQUE,
  serial_number TEXT,
  description TEXT,
  location TEXT,
  condition TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('new', 'good', 'fair', 'needs_repair', 'retired', 'lost', 'unknown')),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'checked_out', 'maintenance', 'retired', 'lost')),
  notes TEXT,
  photo_storage_key TEXT,
  photo_url TEXT,
  photo_original_filename TEXT,
  photo_content_type TEXT,
  photo_bytes INTEGER,
  photo_uploaded_at TEXT,
  photo_uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_physical_resources_status_category
  ON physical_resources(status, category, name);
CREATE INDEX IF NOT EXISTS idx_physical_resources_inventory_code
  ON physical_resources(inventory_code)
  WHERE inventory_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_physical_resources_asset_tag
  ON physical_resources(asset_tag)
  WHERE asset_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_physical_resources_serial_number
  ON physical_resources(serial_number)
  WHERE serial_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS physical_resource_checkouts (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES physical_resources(id) ON DELETE CASCADE,
  holder_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  holder_name TEXT,
  holder_email TEXT,
  checked_out_at TEXT NOT NULL,
  due_at TEXT,
  returned_at TEXT,
  checked_out_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  returned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  return_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_physical_resource_checkouts_resource_time
  ON physical_resource_checkouts(resource_id, checked_out_at DESC);
CREATE INDEX IF NOT EXISTS idx_physical_resource_checkouts_holder_user
  ON physical_resource_checkouts(holder_user_id, checked_out_at DESC)
  WHERE holder_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_physical_resource_checkouts_due
  ON physical_resource_checkouts(due_at)
  WHERE returned_at IS NULL AND due_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_physical_resource_checkouts_one_active
  ON physical_resource_checkouts(resource_id)
  WHERE returned_at IS NULL;
