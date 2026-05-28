-- ============================================================
-- MIGRACIÓN MULTI-TENANT: Sanate WhatsApp CRM
-- Ejecutar en Supabase SQL Editor (Dashboard → SQL → New query)
-- ============================================================

-- 1. Crear tabla de tiendas (stores)
CREATE TABLE IF NOT EXISTS oasis_stores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,  -- URL-safe identifier (e.g., "sanate-bogota")
  owner_email TEXT,
  phone       TEXT,                  -- número principal de WhatsApp
  plan        TEXT DEFAULT 'free',   -- free | pro | enterprise
  status      TEXT DEFAULT 'active', -- active | suspended | trial
  config      JSONB DEFAULT '{}',    -- configuración personalizada de la tienda
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 2. Insertar la tienda por defecto (Sánate actual)
INSERT INTO oasis_stores (id, name, slug, owner_email, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Sánate',
  'sanate',
  'sanate333@gmail.com',
  'active'
) ON CONFLICT (slug) DO NOTHING;

-- 3. Agregar store_id a todas las tablas core
-- ── oasis_wa_chats ──
ALTER TABLE oasis_wa_chats
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES oasis_stores(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- ── oasis_wa_messages ──
ALTER TABLE oasis_wa_messages
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES oasis_stores(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- ── oasis_wa_auth ──
ALTER TABLE oasis_wa_auth
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES oasis_stores(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- ── oasis_wa_config ──
ALTER TABLE oasis_wa_config
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES oasis_stores(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- ── oasis_wa_transfers ──
ALTER TABLE oasis_wa_transfers
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES oasis_stores(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- ── oasis_waba_connections ──
ALTER TABLE oasis_waba_connections
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES oasis_stores(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- ── app_config ──
ALTER TABLE app_config
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES oasis_stores(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- 4. Crear índices para rendimiento multi-tenant
CREATE INDEX IF NOT EXISTS idx_wa_chats_store ON oasis_wa_chats(store_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_store ON oasis_wa_messages(store_id);
CREATE INDEX IF NOT EXISTS idx_wa_auth_store ON oasis_wa_auth(store_id);
CREATE INDEX IF NOT EXISTS idx_wa_config_store ON oasis_wa_config(store_id);
CREATE INDEX IF NOT EXISTS idx_wa_transfers_store ON oasis_wa_transfers(store_id);
CREATE INDEX IF NOT EXISTS idx_waba_connections_store ON oasis_waba_connections(store_id);
CREATE INDEX IF NOT EXISTS idx_app_config_store ON app_config(store_id);

-- 5. Índices compuestos (store_id + columnas de consulta frecuente)
CREATE INDEX IF NOT EXISTS idx_wa_chats_store_timestamp ON oasis_wa_chats(store_id, last_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_store_chat ON oasis_wa_messages(store_id, chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_app_config_store_key ON app_config(store_id, key);

-- 6. Hacer que app_config.key sea unique POR store
-- (primero eliminar constraint unique si existe solo en key)
-- ALTER TABLE app_config DROP CONSTRAINT IF EXISTS app_config_key_key;
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_app_config_store_key_unique ON app_config(store_id, key);

-- 7. RLS (Row Level Security) — preparado para cuando se active auth por tienda
-- Por ahora solo estructura; activar cuando se implemente auth multi-tenant
/*
ALTER TABLE oasis_wa_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE oasis_wa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE oasis_wa_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY store_isolation_chats ON oasis_wa_chats
  USING (store_id = current_setting('app.current_store_id')::uuid);

CREATE POLICY store_isolation_messages ON oasis_wa_messages
  USING (store_id = current_setting('app.current_store_id')::uuid);

CREATE POLICY store_isolation_transfers ON oasis_wa_transfers
  USING (store_id = current_setting('app.current_store_id')::uuid);
*/

-- 8. Actualizar registros existentes (asignar store_id por defecto)
UPDATE oasis_wa_chats SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE oasis_wa_messages SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE oasis_wa_auth SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE oasis_wa_config SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE oasis_wa_transfers SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE oasis_waba_connections SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;
UPDATE app_config SET store_id = '00000000-0000-0000-0000-000000000001' WHERE store_id IS NULL;

-- ✅ Migración completada
-- Para agregar una nueva tienda:
-- INSERT INTO oasis_stores (name, slug, owner_email) VALUES ('Mi Tienda', 'mi-tienda', 'email@ejemplo.com');
